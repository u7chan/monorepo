import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type { CodexAuth } from "./auth";

export type CodexLoginStatus = "running" | "succeeded" | "failed" | "cancelled";

export type CodexLoginOption = { id: string; label: string };

export type CodexLoginPrompt =
  | { type: "select"; message: string; options: CodexLoginOption[] }
  | { type: "manual_code"; message: string; placeholder: string | null };

export type CodexLoginState = {
  status: CodexLoginStatus;
  instructions: string | null;
  progress: string | null;
  authUrl: string | null;
  userCode: string | null;
  prompt: CodexLoginPrompt | null;
  error: string | null;
};

export type CodexLoginFailureReason = "in_progress" | "not_running" | "no_prompt" | "invalid_response" | "unavailable";

export class CodexLoginError extends Error {
  readonly reason: CodexLoginFailureReason;

  constructor(reason: CodexLoginFailureReason) {
    super(reason);
    this.name = "CodexLoginError";
    this.reason = reason;
  }
}

export type CodexLoginService = {
  state: () => CodexLoginState | null;
  start: () => Promise<void>;
  respond: (value: string) => void;
  cancel: () => void;
};

export const CODEX_LOGIN_DEADLINE_MS = 10 * 60 * 1000;
const AUTH_URL_WAIT_MS = 1_500;

/** SDK の英語の案内はそのまま出さない。画面に出す文は固定の日本語だけにする。 */
const AUTHORIZE_INSTRUCTIONS = "ブラウザのタブで承認してください。承認が終わると、この画面の表示が自動で更新されます";
const DEVICE_CODE_INSTRUCTIONS = "ブラウザでこの URL を開き、画面に表示されたコードを入力して承認してください";
const SELECT_MESSAGE = "サインイン方法を選んでください";
const MANUAL_CODE_MESSAGE = "ブラウザの最後の画面の URL を貼り付けてください";
/** SDK のリダイレクト先。貼り付ける URL の形が分かるようにする。 */
const MANUAL_CODE_PLACEHOLDER = "http://localhost:1455/auth/callback?...";
const PROGRESS_FALLBACK = "サインインの処理を進めています";

/** 選択肢の id は SDK の公開値。表示名だけを Portal の言葉へ置き換える。 */
const OPTION_LABELS: Record<string, string> = {
  device_code: "デバイスコード（スマホ向け）",
  browser: "ブラウザ（この端末）",
};

const PROGRESS_MESSAGES: readonly (readonly [RegExp, string])[] = [
  [/exchanging (the )?authorization code/i, "認可コードをトークンと交換しています"],
  [/enabling .*models/i, "モデルを有効化しています"],
  [/listening for oauth callback/i, "ブラウザからのコールバックを待っています"],
];

/** この画面が扱えない対話（`text` / `secret`）を見分ける印。文言は画面へ出さない。 */
const UNSUPPORTED_PROMPT_MARKER = "usage-portal:unsupported-auth-prompt";

const FAILURE_TIMEOUT = "一定時間内に承認されなかったため、サインインを中断しました。もう一度試してください";
const FAILURE_PORT_IN_USE =
  "認可のコールバックポート（1455）が使用中です。同じマシンで動いている pi / Codex CLI のサインインを終了してから、もう一度試してください";
const FAILURE_DENIED = "サインインが承認されませんでした。ブラウザに表示された内容を確認して、もう一度試してください";
const FAILURE_UNSUPPORTED =
  "この画面では扱えないサインイン方式です。デバイスコードと貼り付けの方式だけに対応しています";
const FAILURE_UNKNOWN = "サインインに失敗しました。もう一度試してください";

class LoginCancelledError extends Error {
  constructor() {
    super("login cancelled");
  }
}

/**
 * 1 回分のサインイン。SDK は同じ `interaction` で認可 URL を通知し、コールバックが届かない場合だけ
 * 貼り付けを待つ。進行中の値はメモリにだけ置き、終端で必ず落とす。
 */
class CodexLoginSession {
  readonly interaction: AuthInteraction;
  status: CodexLoginStatus = "running";
  #controller = new AbortController();
  #pending: { kind: "select" | "manual_code"; ids: Set<string>; resolve: (value: string) => void } | null = null;
  #promptState: CodexLoginPrompt | null = null;
  #instructions: string | null = null;
  #progress: string | null = null;
  #authUrl: string | null = null;
  #userCode: string | null = null;
  #error: string | null = null;
  #finishing = false;
  #revision = 0;
  #waiters: (() => void)[] = [];
  #deadline: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.interaction = {
      signal: this.#controller.signal,
      prompt: (prompt) => this.#prompt(prompt),
      notify: (event) => this.#notify(event),
    };
  }

  get aborted(): boolean {
    return this.#controller.signal.aborted;
  }

  /** SDK は返っており、sampler の完了待ち。ここからの中断は結果を取り消せない。 */
  get finishing(): boolean {
    return this.#finishing;
  }

  state(): CodexLoginState {
    return {
      status: this.status,
      instructions: this.#instructions,
      progress: this.#progress,
      authUrl: this.#authUrl,
      userCode: this.#userCode,
      prompt: this.#promptState,
      error: this.#error,
    };
  }

  #notify(event: AuthEvent): void {
    if (this.status !== "running") {
      return;
    }

    if (event.type === "auth_url") {
      this.#authUrl = safeAuthUrl(event.url);
      this.#instructions = AUTHORIZE_INSTRUCTIONS;
    } else if (event.type === "device_code") {
      this.#authUrl = safeAuthUrl(event.verificationUri);
      this.#userCode = event.userCode;
      this.#instructions = DEVICE_CODE_INSTRUCTIONS;
    } else if (event.type === "progress") {
      this.#progress = progressMessage(event.message);
    }

    // `info` は画面に出す情報を持たない（SDK の英語文と外部リンクだけ）。
    this.#bump();
  }

  #prompt(prompt: AuthPrompt): Promise<string> {
    if (this.status !== "running") {
      return Promise.reject(new LoginCancelledError());
    }

    if (prompt.type === "text" || prompt.type === "secret") {
      return Promise.reject(new Error(UNSUPPORTED_PROMPT_MARKER));
    }

    const signal = prompt.signal ?? this.#controller.signal;

    // コールバックが先に勝つと prompt.signal が abort される。abort 済みの signal はイベントを
    // 再発火しないため、待ちに入る前にここで見ないと入力欄を立てたまま待ち続ける。
    if (signal.aborted) {
      return Promise.reject(new LoginCancelledError());
    }

    const ids = new Set(prompt.type === "select" ? prompt.options.map((option) => option.id) : []);

    this.#promptState =
      prompt.type === "select"
        ? {
            type: "select",
            message: SELECT_MESSAGE,
            options: prompt.options.map((option) => ({
              id: option.id,
              label: OPTION_LABELS[option.id] ?? option.id,
            })),
          }
        : { type: "manual_code", message: MANUAL_CODE_MESSAGE, placeholder: MANUAL_CODE_PLACEHOLDER };
    this.#bump();

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const done = (action: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        signal.removeEventListener("abort", onAbort);

        if (this.#pending === pending) {
          this.#pending = null;
        }

        this.#promptState = null;
        this.#bump();
        action();
      };
      const onAbort = () => done(() => reject(new LoginCancelledError()));
      const pending = {
        kind: prompt.type,
        ids,
        resolve: (value: string) => done(() => resolve(value)),
      };

      signal.addEventListener("abort", onAbort, { once: true });
      this.#pending = pending;
    });
  }

  /** 貼り付け / 選択の受け取り。待っていない・選択肢に無い値は受け付けない。 */
  respond(value: string): "ok" | "no_prompt" | "invalid_response" {
    const pending = this.#pending;

    if (!pending) {
      return "no_prompt";
    }

    if (value.trim() === "" || (pending.kind === "select" && !pending.ids.has(value))) {
      return "invalid_response";
    }

    pending.resolve(value);

    return "ok";
  }

  holdSuccess(): void {
    if (this.status !== "running") {
      return;
    }

    this.#stopDeadline();
    this.#finishing = true;
    this.#clearInProgress();
    this.#bump();
  }

  settle(status: "succeeded" | "failed" | "cancelled", error: string | null): void {
    if (this.status !== "running") {
      return;
    }

    this.#stopDeadline();
    this.status = status;
    this.#error = error;
    this.#clearInProgress();
    // 進行中の貼り付け待ちを閉じる。SDK の login も終端で signal を閉じるが、こちらを先に確定させる。
    this.#pending = null;
    this.#bump();
  }

  abort(): void {
    this.#controller.abort();
  }

  armDeadline(deadlineMs: number, onExpire: () => void): void {
    this.#deadline = setTimeout(() => {
      this.#deadline = null;
      onExpire();
    }, deadlineMs);
    // 進行中のサインインがプロセスの終了を期限まで待たせない。
    this.#deadline.unref?.();
  }

  async waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (!predicate()) {
      const remaining = deadline - Date.now();

      if (remaining <= 0) {
        return;
      }

      const revision = this.#revision;

      await Promise.race([this.#nextChange(revision), new Promise((resolve) => setTimeout(resolve, remaining))]);
    }
  }

  #nextChange(revision: number): Promise<void> {
    if (this.#revision !== revision) {
      return Promise.resolve();
    }

    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  #clearInProgress(): void {
    this.#authUrl = null;
    this.#instructions = null;
    this.#progress = null;
    this.#promptState = null;
    this.#userCode = null;
  }

  #stopDeadline(): void {
    if (!this.#deadline) {
      return;
    }

    clearTimeout(this.#deadline);
    this.#deadline = null;
  }

  #bump(): void {
    this.#revision += 1;

    const waiters = this.#waiters;

    this.#waiters = [];

    for (const resolve of waiters) {
      resolve();
    }
  }
}

/**
 * Codex のサインインを 1 本だけ進行させ、状態を API 用に公開する。
 * 開始から 10 分で自動中断し、コールバックの待受を解放する。
 */
export function createCodexLoginService(options: {
  auth: Pick<CodexAuth, "login">;
  onSuccess: () => Promise<void>;
  deadlineMs?: number;
  authUrlWaitMs?: number;
  log?: (message: string) => void;
}): CodexLoginService {
  const deadlineMs = options.deadlineMs ?? CODEX_LOGIN_DEADLINE_MS;
  const authUrlWaitMs = options.authUrlWaitMs ?? AUTH_URL_WAIT_MS;
  const log = options.log ?? ((message: string) => console.warn(`[usage-portal] ${message}`));
  let session: CodexLoginSession | null = null;

  async function run(created: CodexLoginSession): Promise<void> {
    try {
      await options.auth.login(created.interaction);
    } catch (error) {
      if (created.status !== "running") {
        return;
      }

      if (created.aborted) {
        created.settle("cancelled", null);

        return;
      }

      const kind = classifyLoginFailure(error);

      // 生の応答・例外文・認可 URL はログにも出さない。分類だけを残す。
      log(`codex login failed (${kind})`);
      created.settle("failed", failureMessage(kind));

      return;
    }

    if (created.status !== "running") {
      return;
    }

    // 成功を公開する前に sampler を 1 回走らせる。未接続のままのカードを見せないため。
    created.holdSuccess();

    try {
      await options.onSuccess();
    } catch {
      log("codex login refresh failed");
    }

    created.settle("succeeded", null);
  }

  return {
    state() {
      return session?.state() ?? null;
    },
    async start() {
      if (session?.status === "running") {
        throw new CodexLoginError("in_progress");
      }

      const created = new CodexLoginSession();

      session = created;
      created.armDeadline(deadlineMs, () => {
        if (created.status !== "running" || created.finishing) {
          return;
        }

        log("codex login failed (timeout)");
        created.settle("failed", FAILURE_TIMEOUT);
        created.abort();
      });
      void run(created);

      // 最初の表示（選択肢か認可 URL）が決まるまで短く待つ。待ち切れなくても次の GET が拾う。
      await created.waitFor(
        () => created.state().authUrl !== null || created.state().prompt !== null || created.status !== "running",
        authUrlWaitMs,
      );
    },
    respond(value) {
      if (!session || session.status !== "running" || session.finishing) {
        throw new CodexLoginError("not_running");
      }

      const result = session.respond(value);

      if (result === "no_prompt") {
        throw new CodexLoginError("no_prompt");
      }

      if (result === "invalid_response") {
        throw new CodexLoginError("invalid_response");
      }
    },
    cancel() {
      if (!session) {
        return;
      }

      if (session.status !== "running") {
        session = null;

        return;
      }

      if (session.finishing) {
        return;
      }

      session.settle("cancelled", null);
      session.abort();
    },
  };
}

export type CodexLoginFailureKind = "port_in_use" | "denied" | "unsupported" | "unknown";

/** SDK / provider の英語メッセージはここで止める。応答にもログにも出さない。 */
export function classifyLoginFailure(error: unknown): CodexLoginFailureKind {
  const message = error instanceof Error ? error.message : "";

  if (/is in use|EADDRINUSE/i.test(message)) {
    return "port_in_use";
  }

  if (/access_denied|authorization failed/i.test(message)) {
    return "denied";
  }

  if (message.includes(UNSUPPORTED_PROMPT_MARKER)) {
    return "unsupported";
  }

  return "unknown";
}

function failureMessage(kind: CodexLoginFailureKind): string {
  switch (kind) {
    case "port_in_use":
      return FAILURE_PORT_IN_USE;
    case "denied":
      return FAILURE_DENIED;
    case "unsupported":
      return FAILURE_UNSUPPORTED;
    default:
      return FAILURE_UNKNOWN;
  }
}

function progressMessage(message: string): string {
  for (const [pattern, text] of PROGRESS_MESSAGES) {
    if (pattern.test(message)) {
      return text;
    }
  }

  return PROGRESS_FALLBACK;
}

/** 認可 URL として画面に出してよい形だけを通す。`javascript:` をリンクにしないため。 */
function safeAuthUrl(value: string): string | null {
  try {
    const url = new URL(value);

    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}
