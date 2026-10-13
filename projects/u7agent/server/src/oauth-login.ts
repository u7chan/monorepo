/**
 * 設定 → モデルの OAuth サインイン (Sign in with ChatGPT)。
 *
 * SDK の公開 API (`ModelRuntime.login(provider, "oauth", interaction, { getDeviceId, agentName })` / `logout`)
 * だけを使い、資格情報の保存・更新は Pi の `auth.json` に委ねる (アプリ DB は触らない)。進行中の状態だけを
 * メモリに持ち、完了・失敗・キャンセルで公開 state を 1 回再計算する。契約は docs/model-settings.md を正とする。
 */
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { httpError, messageFor } from "./http";
import { MutationLock } from "./model-settings";
import type { OAuthLoginState } from "./schema";

export const OAUTH_LOGIN_RUNTIME_UNAVAILABLE_MESSAGE = "ランタイムが利用できないため、サインインできません";
export const OAUTH_LOGIN_TARGET_MESSAGE = "このプロバイダーはサインインに対応していません";
export const OAUTH_LOGIN_IN_PROGRESS_MESSAGE = "このプロバイダーはサインインが進行中です";
export const OAUTH_LOGIN_NOT_RUNNING_MESSAGE = "進行中のサインインがありません";
export const OAUTH_LOGIN_NO_INPUT_MESSAGE = "いまは貼り付けを受け付けていません";
export const OAUTH_LOGIN_UNSUPPORTED_MESSAGE =
  "この画面では扱えないサインイン方式です。貼り付けコードとデバイスコードの方式だけに対応しています";
export const OAUTH_LOGIN_FAILED_MESSAGE = "サインインに失敗しました。もう一度試してください";
export const OAUTH_LOGIN_FAILED_PORT_MESSAGE =
  "認可のコールバックポート（1455）が使用中です。同じマシンで動いている pi / Codex CLI のサインインを終了してから、もう一度試してください";
export const OAUTH_LOGIN_FAILED_DENIED_MESSAGE =
  "サインインが承認されませんでした。ブラウザに表示された内容を確認して、もう一度試してください";
export const OAUTH_LOGOUT_TARGET_MESSAGE = "保存済みの OAuth 資格情報がありません";
export const OAUTH_LOGOUT_FAILED_MESSAGE = "サインアウトできませんでした。もう一度試してください";
/** 1 つの面に収めるため長さを抑えた固定文言。SDK の英語の案内は画面へ出さない */
export const OAUTH_LOGIN_AUTHORIZE_INSTRUCTIONS =
  "同じマシンのブラウザでこの URL を開き、承認してください。承認後にアプリへ戻らないときは、ブラウザの最後の画面の URL を貼り付けてください";
export const OAUTH_LOGIN_DEVICE_CODE_INSTRUCTIONS =
  "ブラウザでこの URL を開き、画面に表示されたコードを入力して承認してください";
export const OAUTH_LOGIN_INPUT_MESSAGE =
  "ブラウザの最後の画面の URL（http://127.0.0.1:1455/auth/callback から始まる URL）を貼り付けてください";
export const OAUTH_LOGIN_INPUT_PLACEHOLDER = "http://127.0.0.1:1455/auth/callback?code=...";
const OAUTH_LOGIN_PROGRESS_FALLBACK = "サインインの処理を進めています";

/** SDK が送る進捗の英語文言のうち、意味が確定しているものだけを日本語へ寄せる (他は汎用の文言) */
const PROGRESS_MESSAGES: readonly (readonly [RegExp, string])[] = [
  [/exchanging (the )?authorization code/i, "認可コードをトークンと交換しています"],
  [/enabling .*models/i, "モデルを有効化しています"],
  [/listening for oauth callback/i, "ブラウザからのコールバックを待っています"],
];

/** 貼り付け欄で扱えない対話 (`select` / `text` / `secret`) を来たことを示す印。文言は画面へ出さない */
const UNSUPPORTED_PROMPT_MARKER = "u7agent:unsupported-auth-prompt";

export type OAuthLoginFailureKind = "port_in_use" | "denied" | "unsupported" | "unknown";

/**
 * 生の例外文言を画面用の固定文言へ分類する。SDK / provider の英語メッセージはここで止め、
 * 応答にもログにも出さない (認可 URL・トークン・client_id が混ざる経路を作らない)。
 */
export function classifyOAuthLoginFailure(message: string): OAuthLoginFailureKind {
  if (/is in use|EADDRINUSE/i.test(message)) return "port_in_use";
  if (/access_denied|authorization failed/i.test(message)) return "denied";
  if (message.includes(UNSUPPORTED_PROMPT_MARKER)) return "unsupported";
  return "unknown";
}

export function oauthLoginFailureMessage(kind: OAuthLoginFailureKind): string {
  switch (kind) {
    case "port_in_use":
      return OAUTH_LOGIN_FAILED_PORT_MESSAGE;
    case "denied":
      return OAUTH_LOGIN_FAILED_DENIED_MESSAGE;
    case "unsupported":
      return OAUTH_LOGIN_UNSUPPORTED_MESSAGE;
    default:
      return OAUTH_LOGIN_FAILED_MESSAGE;
  }
}

/** 認可 URL として画面へ出してよい形だけを通す (provider 側の値で `javascript:` 等を開かせない) */
function safeAuthUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function progressMessage(message: string): string {
  for (const [pattern, text] of PROGRESS_MESSAGES) {
    if (pattern.test(message)) return text;
  }
  return OAUTH_LOGIN_PROGRESS_FALLBACK;
}

export interface OAuthLoginProvider {
  provider: string;
  supportsOAuth: boolean;
  /** provider の `oauth.loginLabel`。ボタンの表示名だけに使う */
  oauthLoginLabel: string | null;
}

/** SDK との継ぎ目。資格情報の値は受け取らず、種別だけを見る */
export interface OAuthLoginRuntime {
  list(): OAuthLoginProvider[];
  /** SDK の OAuth ログイン。credential は返さず、保存は Pi (auth.json) に委ねる */
  loginOAuth(provider: string, interaction: AuthInteraction): Promise<void>;
  /** 保存済み資格情報の削除。provider 側の失効はしない */
  logoutOAuth(provider: string, options: { signal: AbortSignal }): Promise<void>;
  /** SDK が見ている資格情報が OAuth か (null = 未設定 / APIキー) */
  credentialKind(provider: string): "oauth" | null;
  /** `auth.json` の保存値の種別 (表示専用)。読めない / 行が無いときは undefined */
  storedCredentialKind(provider: string): "oauth" | "api_key" | undefined;
}

export interface OAuthLoginOptions {
  /** null = ランタイム初期化失敗。開始・サインアウトは 503 */
  runtime: OAuthLoginRuntime | null;
  /** 公開 state の再計算。完了・失敗・キャンセルで 1 回だけ呼ぶ。例外を出さない契約 */
  refresh: () => Promise<void>;
  /** ログへ出す前の文言境界 (可変マスカー) */
  maskError: (text: string) => string;
  /** 認可 URL が届くまで開始の応答を待つ上限。0 で待たない */
  waitForAuthUrlMs?: number;
  /** SDK の logout の期限 */
  logoutTimeoutMs?: number;
}

export const OAUTH_LOGIN_AUTH_URL_WAIT_MS = 1_500;
export const OAUTH_LOGOUT_TIMEOUT_MS = 20_000;

export type OAuthLoginOutcome = { status: 200 } | { status: 503; error: string };

class LoginCancelledError extends Error {
  constructor() {
    super("Login cancelled");
  }
}

/**
 * 1 provider 分の進行状態と SDK との対話。SDK は同じ `interaction` を通じて認可 URL を通知し、コールバックが
 * 届かない場合だけ `manual_code` の貼り付けを待つ。貼り付けは SDK がコールバックと競争させるため、
 * 応答しないまま待ち続けてよい (中断のときだけ signal で閉じる)。
 */
class OAuthLoginSession {
  readonly provider: string;
  readonly interaction: AuthInteraction;
  status: "running" | "succeeded" | "failed" | "cancelled" = "running";
  authUrl: string | null = null;
  instructions: string | null = null;
  progress: string | null = null;
  input: { message: string; placeholder: string } | null = null;
  userCode: string | null = null;
  error: string | null = null;

  #controller = new AbortController();
  #pending: { resolve: (value: string) => void; reject: (error: unknown) => void } | null = null;
  #revision = 0;
  #waiters: (() => void)[] = [];

  constructor(provider: string) {
    this.provider = provider;
    this.interaction = {
      signal: this.#controller.signal,
      prompt: (prompt) => this.#prompt(prompt),
      notify: (event) => this.#notify(event),
    };
  }

  /** 中断済みか。SDK の login が signal を見ずに終了した場合も cancel 側で確定できるようにする */
  get aborted(): boolean {
    return this.#controller.signal.aborted;
  }

  state(): OAuthLoginState {
    return {
      status: this.status,
      authUrl: this.authUrl,
      instructions: this.instructions,
      progress: this.progress,
      input: this.input,
      userCode: this.userCode,
      error: this.error,
    };
  }

  /** 承認 URL (`auth_url` / デバイスコード) の通知。認可 URL は進行中の state としてだけ公開する */
  #notify(event: AuthEvent): void {
    if (this.status !== "running") return;
    if (event.type === "auth_url") {
      this.authUrl = safeAuthUrl(event.url);
      this.instructions = OAUTH_LOGIN_AUTHORIZE_INSTRUCTIONS;
    } else if (event.type === "device_code") {
      this.authUrl = safeAuthUrl(event.verificationUri);
      this.userCode = event.userCode;
      this.instructions = OAUTH_LOGIN_DEVICE_CODE_INSTRUCTIONS;
    } else if (event.type === "progress") {
      this.progress = progressMessage(event.message);
    }
    this.#bump();
  }

  /** 貼り付け待ち。`manual_code` だけを受け付け、他の対話は固定文言の失敗へ倒す */
  #prompt(prompt: AuthPrompt): Promise<string> {
    if (prompt.type !== "manual_code") return Promise.reject(new Error(UNSUPPORTED_PROMPT_MARKER));
    const signal = prompt.signal ?? this.#controller.signal;
    this.input = { message: OAUTH_LOGIN_INPUT_MESSAGE, placeholder: OAUTH_LOGIN_INPUT_PLACEHOLDER };
    this.#bump();
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const pending = {
        resolve: (value: string) => done(() => resolve(value)),
        reject: (error: unknown) => done(() => reject(error)),
      };
      const done = (action: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (this.#pending === pending) this.#pending = null;
        this.input = null;
        this.#bump();
        action();
      };
      const onAbort = () => done(() => reject(new LoginCancelledError()));
      signal.addEventListener("abort", onAbort, { once: true });
      this.#pending = pending;
    });
  }

  /** 貼り付けの受け取り。待っていないときは false (route が 400 へ寄せる) */
  submitCode(code: string): boolean {
    const pending = this.#pending;
    if (!pending) return false;
    pending.resolve(code);
    return true;
  }

  /** 終端の確定。認可 URL と貼り付け欄は進行中の値なので、終端では必ず落とす */
  settle(status: "succeeded" | "failed" | "cancelled", error: string | null): void {
    if (this.status !== "running") return;
    this.status = status;
    this.error = error;
    this.authUrl = null;
    this.instructions = null;
    this.progress = null;
    this.userCode = null;
    const pending = this.#pending;
    // 進行中の貼り付け待ちを閉じる (SDK 側も login の終了で signal を閉じるが、こちらを先に確定させる)
    pending?.reject(new LoginCancelledError());
    this.#bump();
  }

  /** SDK のコールバックサーバーと通信を止める */
  abort(): void {
    this.#controller.abort();
  }

  /** 状態が変わるか期限に当たるまで待つ。開始の応答へ認可 URL を載せるためだけに使う */
  async waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const revision = this.#revision;
      await Promise.race([this.#nextChange(revision), new Promise((resolve) => setTimeout(resolve, remaining))]);
    }
  }

  #nextChange(revision: number): Promise<void> {
    if (this.#revision !== revision) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  #bump(): void {
    this.#revision += 1;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }
}

export class OAuthLoginService {
  #runtime: OAuthLoginRuntime | null;
  #refreshState: () => Promise<void>;
  #maskError: (text: string) => string;
  #waitForAuthUrlMs: number;
  #logoutTimeoutMs: number;
  #logins = new Map<string, OAuthLoginSession>();
  // キー変更と同じロックは使わない。進行中のサインインは分単位で待つため、同じロックで直列化すると
  // その間キーの保存が止まる。触るストアも違う (DB と auth.json)
  #lock = new MutationLock();

  constructor(options: OAuthLoginOptions) {
    this.#runtime = options.runtime;
    this.#refreshState = options.refresh;
    this.#maskError = options.maskError;
    this.#waitForAuthUrlMs = options.waitForAuthUrlMs ?? OAUTH_LOGIN_AUTH_URL_WAIT_MS;
    this.#logoutTimeoutMs = options.logoutTimeoutMs ?? OAUTH_LOGOUT_TIMEOUT_MS;
  }

  /** GET へ載せる進行中の状態。進行中も直近の結果も無ければ null */
  stateOf(provider: string): OAuthLoginState | null {
    return this.#logins.get(provider)?.state() ?? null;
  }

  /**
   * サインインの開始。SDK の login は応答を待たずにバックグラウンドで走らせ、完了・失敗・キャンセルで
   * 公開 state を 1 回再計算する。認可 URL だけは発行まで短く待って応答へ載せる (届かなければ次の GET が拾う)。
   */
  async start(provider: string): Promise<OAuthLoginOutcome> {
    const session = await this.#lock.run(async () => {
      if (!this.#runtime) throw httpError(503, OAUTH_LOGIN_RUNTIME_UNAVAILABLE_MESSAGE);
      const entry = this.#runtime.list().find((candidate) => candidate.provider === provider);
      if (!entry?.supportsOAuth) throw httpError(400, OAUTH_LOGIN_TARGET_MESSAGE);
      if (this.#logins.get(provider)?.status === "running") throw httpError(409, OAUTH_LOGIN_IN_PROGRESS_MESSAGE);
      const created = new OAuthLoginSession(provider);
      this.#logins.set(provider, created);
      void this.#run(provider, created);
      return created;
    });
    if (this.#waitForAuthUrlMs > 0) {
      await session.waitFor(() => session.authUrl !== null || session.status !== "running", this.#waitForAuthUrlMs);
    }
    return { status: 200 };
  }

  /** 貼り付けられた URL / コードを SDK の待機へ渡す。交換の完了はポーリングが拾う */
  async submitCode(provider: string, code: string): Promise<OAuthLoginOutcome> {
    const session = this.#logins.get(provider);
    if (session?.status !== "running") throw httpError(400, OAUTH_LOGIN_NOT_RUNNING_MESSAGE);
    if (!session.submitCode(code)) throw httpError(400, OAUTH_LOGIN_NO_INPUT_MESSAGE);
    return { status: 200 };
  }

  /**
   * 中断 (進行中) と結果表示の消去 (終端)。冪等にして、完了直後に押された [中断] を 400 にしない。
   * 進行中を止めるときはコールバックサーバーと通信を閉じ、公開 state を再計算する。
   */
  async cancel(provider: string): Promise<OAuthLoginOutcome> {
    return this.#lock.run(async () => {
      const session = this.#logins.get(provider);
      if (!session) return { status: 200 };
      if (session.status !== "running") {
        this.#logins.delete(provider);
        return { status: 200 };
      }
      session.settle("cancelled", null);
      session.abort();
      // 公開 state の再計算は #run の finally が 1 回だけ行う (中断直後に完了したログインも拾えるようにする)
      return { status: 200 };
    });
  }

  /**
   * サインアウト。Pi の `auth.json` から OAuth を消すだけで、provider 側の接続は失効させない
   * (解除は ChatGPT の設定から行う)。この画面で登録したキー (アプリ DB の行) は触らない。
   */
  async logout(provider: string): Promise<OAuthLoginOutcome> {
    return this.#lock.run(async () => {
      if (!this.#runtime) throw httpError(503, OAUTH_LOGIN_RUNTIME_UNAVAILABLE_MESSAGE);
      if (this.#logins.get(provider)?.status === "running") throw httpError(409, OAUTH_LOGIN_IN_PROGRESS_MESSAGE);
      if (!this.#hasStoredOAuth(provider)) throw httpError(400, OAUTH_LOGOUT_TARGET_MESSAGE);
      try {
        await this.#runtime.logoutOAuth(provider, { signal: AbortSignal.timeout(this.#logoutTimeoutMs) });
      } catch {
        // 生の例外文言は応答にもログにも出さない。値が混ざり得る経路を作らないため provider だけを残す
        console.warn(`[u7agent] oauth logout failed: ${provider}`);
        throw httpError(503, OAUTH_LOGOUT_FAILED_MESSAGE);
      }
      await this.#refresh();
      return { status: 200 };
    });
  }

  /** SDK の login をバックグラウンドで走らせ、終端で公開 state を再計算する */
  async #run(provider: string, session: OAuthLoginSession): Promise<void> {
    const runtime = this.#runtime;
    if (!runtime) return;
    try {
      await runtime.loginOAuth(provider, session.interaction);
      // 中断済みの state を成功で上書きしない (cancel が先に state を確定している)
      if (session.status === "running") session.settle("succeeded", null);
    } catch (error) {
      if (session.status === "running") {
        if (session.aborted) {
          session.settle("cancelled", null);
        } else {
          const kind = classifyOAuthLoginFailure(messageFor(error));
          // 生の文言は応答にもログにも出さない (認可 URL・トークンが混ざる可能性のある値)
          console.warn(`[u7agent] oauth login failed: ${provider} (${kind})`);
          session.settle("failed", oauthLoginFailureMessage(kind));
        }
      }
    } finally {
      // 中断 / 中断直後の完了でも、SDK が返った時点の資格情報を公開 state へ写す
      await this.#refresh();
    }
  }

  /** 表示専用の auth.json 読取を先に試し、SDK が見ている種別を補いにする */
  #hasStoredOAuth(provider: string): boolean {
    try {
      if (this.#runtime?.storedCredentialKind(provider) === "oauth") return true;
    } catch {
      // 読取の失敗を「OAuth が無い」と断定せず、SDK が見ている種別へ倒す
    }
    return this.#runtime?.credentialKind(provider) === "oauth";
  }

  async #refresh(): Promise<void> {
    try {
      await this.#refreshState();
    } catch (error) {
      console.warn(`[u7agent] oauth state refresh failed: ${this.#maskError(messageFor(error))}`);
    }
  }
}
