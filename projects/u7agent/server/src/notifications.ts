/**
 * Discord の Incoming Webhook 通知。設定の読み書き・宛先検証・送信・直近結果・専用マスクをここへ閉じる。
 * 送信は fire-and-forget で、SessionStore.finish() を待たせない (失敗してもランは完了させる)。
 */
import type { AppDb, NotificationSettingsRow, StoredAppSecret } from "./app-db";
import {
  APP_SECRET_MASTER_KEY_MESSAGE,
  appSecretAvailable,
  appSecretFailed,
  appSecretMasterKeyMissing,
  appSecretNotStored,
  appSecretUnevaluated,
  type AppSecretState,
} from "./app-secrets";
import { httpError, messageFor } from "./http";
import { createSecretMasker, REDACTED, type SecretMasker } from "./redact";
import { truncate } from "./session-projection";
import { spaceIdOf } from "./spaces";
import type { AppSecretCipher } from "./secret-crypto";
import type { NotificationResult, NotificationsResponse, UpdateNotificationsBody } from "./schema";

/** Discord Webhook のタイムアウト。テスト送信も通常通知も同じ値を使う */
export const NOTIFICATION_TIMEOUT_MS = 5_000;
/** 通知本文に載せる最終応答の上限 (マスクしてから切り詰める) */
export const NOTIFICATION_BODY_MAX = 200;
/** 宛先の検証失敗。URL の値そのものは応答・ログへ出さない */
export const WEBHOOK_URL_ERROR = "Webhook URL は https://discord.com/api/webhooks/<id>/<token> の形だけを受け付けます";
export const BASE_URL_ERROR = "Base URL は http(s) の origin だけを受け付けます";
/** Webhook URL は保存済みだが復号できないときの、送信を止める文言 (応答にもそのまま載せる) */
export const WEBHOOK_UNAVAILABLE_MESSAGE =
  "保存済みの Webhook URL を復号できないため通知を送信できません。URL を再入力してください";
/** 復号した URL を AAD に結び付ける所有者。変更すると保存済みの URL を復号できなくなる */
const WEBHOOK_SECRET_OWNER = "webhookUrl";
/** 変更前の URL もマスクできるよう、置換対象は直近の数件だけメモリに持つ */
const MAX_KNOWN_URLS = 8;
/** 未知の URL でも `/api/webhooks/…` 以降は潰す (応答・ログ・例外の最終防波堤) */
const WEBHOOK_PATH_PATTERN = /\/api\/webhooks\/[^\s"'<>`)\]}]+/g;
/** Discord のエラー本文を読む上限。超える応答は原文を解釈しない */
const DISCORD_ERROR_BODY_MAX = 4_096;

export interface NotificationServiceOptions {
  db: AppDb;
  /** セッションと同じ secret masker (API キーを通知本文へ広げない) */
  masker?: SecretMasker | null;
  /** 送信のテスト用。省略時は globalThis.fetch */
  fetchImpl?: typeof fetch;
  /** タイムアウトの上書き (テスト用)。既定は NOTIFICATION_TIMEOUT_MS */
  timeoutMs?: number;
  /** master key が無い / 不正なときは null。保存と復号は 503 / 未設定表示にする */
  cipher?: AppSecretCipher | null;
  /**
   * SDK ランタイムを初期化できたか。false のときは復号せず、保存済みの URL を「未評価」にする
   * (復号した値を使う経路が無いため、メモリにも残さない)。
   */
  runtimeAvailable?: boolean;
}

/** ラン完了通知の中身 (マスク前の生値) */
export interface SessionNotificationInput {
  sessionId: string;
  /** 会話の所属スペース。未指定・不正は通知層が既定として扱う (通知を失わない) */
  spaceId?: string;
  title: string;
  agentName: string;
  /** 最終 assistant の本文 */
  body: string;
  durationMs: number;
  toolCalls: number;
}

/** 質問通知の中身 (マスク前の生値) */
export interface QuestionNotificationInput {
  sessionId: string;
  /** 会話の所属スペース。未指定・不正は通知層が既定として扱う (通知を失わない) */
  spaceId?: string;
  title: string;
  agentName: string;
  questionCount: number;
  /** 最初の質問の本文。会話の通知が Off のときは undefined (タイトルも載せない) */
  question?: string;
}

/**
 * Discord の正規の宛先だけを許可する (SSRF / リダイレクト対策)。host 固定・パスは 2 セグメントで、
 * userinfo / クエリ / フラグメント / 非標準ポートは拒否する。例外へ URL を入れない。
 */
export function normalizeWebhookUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw httpError(400, WEBHOOK_URL_ERROR);
  }
  if (url.protocol !== "https:" || url.hostname !== "discord.com" || url.port !== "") {
    throw httpError(400, WEBHOOK_URL_ERROR);
  }
  if (url.username || url.password || url.search || url.hash) throw httpError(400, WEBHOOK_URL_ERROR);
  const segments = url.pathname.split("/");
  // ["", "api", "webhooks", "<id>", "<token>"]
  if (segments.length !== 5 || segments[1] !== "api" || segments[2] !== "webhooks") {
    throw httpError(400, WEBHOOK_URL_ERROR);
  }
  if (!isWebhookSegment(segments[3]) || !isWebhookSegment(segments[4])) throw httpError(400, WEBHOOK_URL_ERROR);
  // 保存は正規化した値に揃える (大文字ホストや末尾スラッシュの表記ゆれを持ち込まない)
  return url.href;
}

/** id / token は base64url 相当の文字だけ。パーセントエンコードやパス区切りを混ぜない */
function isWebhookSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

/** 通知から開く URL のベース。origin だけを許可し、空は「リンクを載せない」を表す */
export function normalizeBaseUrl(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  // URL パーサはタブ・改行を黙って落とすため、制御文字は parse の前に弾く
  if (hasControlChars(value)) throw httpError(400, BASE_URL_ERROR);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw httpError(400, BASE_URL_ERROR);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw httpError(400, BASE_URL_ERROR);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw httpError(400, BASE_URL_ERROR);
  }
  return url.origin;
}

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Webhook URL を [REDACTED] へ潰す。既知の URL (現在 + 直前に保存した値) は全体を、
 * 未知の値でも `/api/webhooks/…` 以降はパス部分を潰す。
 */
export function maskWebhook(text: string, knownUrls: readonly string[] = []): string {
  let result = text;
  for (const url of knownUrls) {
    if (url && result.includes(url)) result = result.split(url).join(REDACTED);
  }
  return result.replace(WEBHOOK_PATH_PATTERN, REDACTED);
}

/**
 * 通知本文のリンク。`space` は開くスペースの明示で、保存値に依存せずその会話の所属で開くために載せる。
 * baseUrl 未設定なら undefined (リンク行ごと出さない)。spaceId が undefined のときは付けない。
 */
export function deepLink(baseUrl: string | null | undefined, sessionId: string, spaceId?: string): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const url = new URL(`/s/${encodeURIComponent(sessionId)}`, baseUrl);
    if (spaceId !== undefined) url.searchParams.set("space", spaceId);
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * 通知に載せるスペース。通知層で正規化するのは、不正値で fire-and-forget の外へ例外を出さないため
 * (notifyCompleted は待たない)。検証できない値は通知ごと落とさず、`?space=` なしで送る。
 */
function spaceOfNotification(spaceId: string | undefined): string | undefined {
  try {
    return spaceIdOf(spaceId);
  } catch {
    return undefined;
  }
}

/** Discord の retry_after は秒 (小数)。表示用に切り上げ、読めない値は載せない */
function retryAfterSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.ceil(value);
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${seconds}秒`;
  if (minutes < 60) return `${minutes}分${seconds % 60}秒`;
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}

export class NotificationService {
  #db: AppDb;
  #masker: SecretMasker;
  #fetch: typeof fetch;
  #timeoutMs: number;
  /** 現在 + 直前に保存した Webhook URL (マスク用) */
  #knownUrls: string[];
  #cipher: AppSecretCipher | null;
  #runtimeAvailable: boolean;
  /** 復号済みの Webhook URL。GET では復号しないため、起動時と保存 / 置換の結果だけを持つ */
  #webhookUrl: string | null = null;
  #webhookState: AppSecretState = appSecretNotStored();
  /** 送信開始ごとに増える世代。古い完了で新しい直近結果を上書きしない */
  #generation = 0;
  #closed = false;

  constructor({ db, masker, fetchImpl, timeoutMs, cipher, runtimeAvailable }: NotificationServiceOptions) {
    this.#db = db;
    this.#masker = masker ?? createSecretMasker([]);
    this.#fetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = timeoutMs ?? NOTIFICATION_TIMEOUT_MS;
    this.#cipher = cipher ?? null;
    this.#runtimeAvailable = runtimeAvailable ?? true;
    this.#knownUrls = [];
    // 再起動直後も送信とマスクができるように、起動時に 1 回だけ復号する (DB が使えないときは health が理由を持つ)
    try {
      const stored = db.getNotificationSettings()?.webhook;
      if (stored) this.#evaluateWebhook(stored);
    } catch {
      // 通知のために起動を止めない。GET で初めて暗号文を確認した行は未評価として返す
      this.#webhookUrl = null;
      this.#webhookState = appSecretUnevaluated();
    }
  }

  /** 保存済みの暗号文から URL を復号する。結果はプロセスのメモリだけに残す */
  #evaluateWebhook(secret: StoredAppSecret): void {
    this.#webhookUrl = null;
    if (!this.#runtimeAvailable) {
      this.#webhookState = appSecretUnevaluated();
      return;
    }
    if (!this.#cipher) {
      this.#webhookState = appSecretMasterKeyMissing();
      return;
    }
    try {
      const webhookUrl = this.#cipher.decrypt("notification_settings", WEBHOOK_SECRET_OWNER, secret);
      this.#webhookUrl = webhookUrl;
      this.#webhookState = appSecretAvailable();
      this.#remember(webhookUrl);
    } catch {
      // 誤鍵・未知の鍵版・改ざんは区別せず、平文へも落とさない
      this.#webhookState = appSecretFailed();
    }
  }

  /** GET / PUT の応答。保存済み URL もその断片も返さない (write-only) */
  settings(): NotificationsResponse {
    const settings = this.#read();
    const configured = settings.webhook !== null;
    return {
      enabled: settings.enabled,
      askUser: settings.askUser,
      provider: "discord",
      configured,
      // 未設定は「復号の失敗」ではないので、評価済みの利用不可として扱う
      webhookAvailable: configured && this.#webhookState.keyAvailable,
      webhookEvaluated: configured ? this.#webhookState.keyEvaluated : true,
      webhookErrorMessage: configured ? this.#webhookState.keyErrorMessage : null,
      ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
      ...(settings.lastResult ? { lastResult: settings.lastResult } : {}),
    };
  }

  /** 設定の保存。宛先とベース URL を検証し、URL は暗号化してから書き、保存時に送信テストはしない */
  save(input: UpdateNotificationsBody): NotificationsResponse {
    const current = this.#read();
    const next: NotificationSettingsRow = { ...current };
    if (input.enabled !== undefined) next.enabled = input.enabled;
    // 旧クライアントの PUT (askUser 省略) は保存値を維持し、既定の補完は読み取り側だけで行う
    if (input.askUser !== undefined) next.askUser = input.askUser;
    if (input.webhookUrl !== undefined) {
      const webhookUrl = input.webhookUrl === null ? undefined : normalizeWebhookUrl(input.webhookUrl);
      // 復号できない保存値は「別の URL がある」として扱い、直近結果を捨てる
      const changed = webhookUrl === undefined ? current.webhook !== null : webhookUrl !== this.#webhookUrl;
      // URL を変えたら直近結果を捨てる。進行中の送信結果も世代で採用しない
      if (changed) {
        this.#generation += 1;
        if (this.#webhookUrl) this.#remember(this.#webhookUrl);
        if (webhookUrl) this.#remember(webhookUrl);
        next.lastResult = null;
      }
      if (webhookUrl) {
        const encrypted = this.#requireCipher().encrypt("notification_settings", WEBHOOK_SECRET_OWNER, webhookUrl);
        next.webhook = encrypted;
        this.#webhookUrl = webhookUrl;
        this.#webhookState = appSecretAvailable();
      } else {
        next.webhook = null;
        this.#webhookUrl = null;
        this.#webhookState = appSecretNotStored();
      }
    }
    if (input.baseUrl !== undefined) {
      const baseUrl = input.baseUrl === null ? undefined : normalizeBaseUrl(input.baseUrl);
      next.baseUrl = baseUrl ?? null;
    }
    this.#db.saveNotificationSettings(next);
    return this.settings();
  }

  /** 保存済み設定で 1 通送る (通知の有効 / 無効に関係なく実行できる) */
  async test(): Promise<NotificationResult> {
    const settings = this.#read();
    if (!settings.webhook) throw httpError(400, "Webhook URL が設定されていません");
    return this.#send(this.#requireWebhook(), testPayload());
  }

  /** ラン完了通知。fire-and-forget で、例外はここで握る (呼び出し側のランを止めない) */
  notifySession(input: SessionNotificationInput): void {
    void this.#notifySession(input);
  }

  /** 質問通知。fire-and-forget で、例外はここで握る (質問の登録・回答を止めない) */
  notifyQuestion(input: QuestionNotificationInput): void {
    void this.#notifyQuestion(input);
  }

  /** 送信中のままプロセスを閉じるときに呼ぶ。以後の結果は記録しない */
  close(): void {
    this.#closed = true;
  }

  async #notifySession(input: SessionNotificationInput): Promise<void> {
    try {
      const settings = this.#read();
      if (!settings.enabled || !settings.webhook) return;
      if (!this.#webhookUrl) {
        this.#recordUnavailable();
        return;
      }
      await this.#send(this.#webhookUrl, this.#sessionPayload(settings, input));
    } catch (error) {
      // 送信の失敗は直近結果に残る。ここへ来るのは設定が読めない等の想定外だけ
      console.warn(`[u7agent] 通知を送信できません: ${this.#mask(messageFor(error))}`);
    }
  }

  #sessionPayload(settings: NotificationSettingsRow, input: SessionNotificationInput): unknown {
    const title = this.#mask(input.title) || "無題のセッション";
    const summary = [this.#mask(input.agentName), formatDuration(input.durationMs), `ツール ${input.toolCalls}件`]
      .filter(Boolean)
      .join(" ・ ");
    // マスクしてから切り詰める (逆順だと上限の境界でキーの末尾が欠ける)
    const body = truncate(this.#mask(input.body), NOTIFICATION_BODY_MAX);
    const link = deepLink(settings.baseUrl, input.sessionId, spaceOfNotification(input.spaceId));
    return {
      embeds: [
        {
          title: `✅ 完了  ${title}`,
          description: [summary, body, ...(link ? [link] : [])].filter(Boolean).join("\n"),
        },
      ],
    };
  }

  async #notifyQuestion(input: QuestionNotificationInput): Promise<void> {
    try {
      const settings = this.#read();
      if (!settings.enabled || !settings.askUser || !settings.webhook) return;
      if (!this.#webhookUrl) {
        this.#recordUnavailable();
        return;
      }
      await this.#send(this.#webhookUrl, this.#questionPayload(settings, input));
    } catch (error) {
      console.warn(`[u7agent] 質問通知を送信できません: ${this.#mask(messageFor(error))}`);
    }
  }

  #questionPayload(settings: NotificationSettingsRow, input: QuestionNotificationInput): unknown {
    // 会話の通知が Off の会話ではタイトルも質問文も載せず、何が起きたかとリンクだけを送る
    const body = input.question === undefined ? undefined : truncate(this.#mask(input.question), NOTIFICATION_BODY_MAX);
    const summary = [this.#mask(input.agentName), `質問 ${input.questionCount}件`].filter(Boolean).join(" ・ ");
    const link = deepLink(settings.baseUrl, input.sessionId, spaceOfNotification(input.spaceId));
    return {
      embeds: [
        {
          title:
            body === undefined ? "❓ 質問があります" : `❓ 回答待ち  ${this.#mask(input.title) || "無題のセッション"}`,
          description: [summary, body, ...(link ? [link] : [])].filter(Boolean).join("\n"),
        },
      ],
    };
  }

  async #send(webhookUrl: string, payload: unknown): Promise<NotificationResult> {
    // 送信の開始時点で世代を進める (この送信の結果だけを直近結果の候補にする)
    this.#generation += 1;
    const generation = this.#generation;
    const result = await this.#post(webhookUrl, payload);
    this.#record(generation, result);
    return result;
  }

  async #post(webhookUrl: string, payload: unknown): Promise<NotificationResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    timer.unref?.();
    try {
      const response = await this.#fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        // 3xx を追わない (リダイレクト先へトークンを転送しない)
        redirect: "error",
        signal: controller.signal,
      });
      const latencyMs = Date.now() - startedAt;
      const at = Date.now();
      if (response.ok) return { ok: true, status: response.status, latencyMs, at };
      return { ok: false, status: response.status, latencyMs, at, ...(await this.#discordError(response)) };
    } catch {
      // 例外のメッセージは返さない (URL が混ざり得る。app.ts の onError がそのまま応答本文へ載せる経路がある)
      const seconds = Math.max(1, Math.round(this.#timeoutMs / 1000));
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        at: Date.now(),
        message: timedOut ? `Discord へ接続できません（${seconds} 秒でタイムアウト）` : "Discord へ接続できません",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Discord のエラー本文から code / message だけを取り出す (原文は返さない)。
   * 429 のときだけ retry_after (秒) を切り上げて載せ、他の status では本文にあっても無視する。
   */
  async #discordError(response: Response): Promise<{ message?: string; code?: number; retryAfter?: number }> {
    try {
      const text = await response.text();
      if (text.length > DISCORD_ERROR_BODY_MAX) return {};
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") return {};
      const record = parsed as Record<string, unknown>;
      const code = typeof record.code === "number" ? record.code : undefined;
      const message = typeof record.message === "string" ? this.#mask(record.message) : undefined;
      const retryAfter = response.status === 429 ? retryAfterSeconds(record.retry_after) : undefined;
      return {
        ...(message ? { message } : {}),
        ...(code === undefined ? {} : { code }),
        ...(retryAfter === undefined ? {} : { retryAfter }),
      };
    } catch {
      return {};
    }
  }

  /** 復号できない URL では送信せず、固定文言の失敗として直近結果に残す (世代は送信と同じく進める) */
  #recordUnavailable(): void {
    this.#generation += 1;
    this.#record(this.#generation, {
      ok: false,
      latencyMs: 0,
      at: Date.now(),
      message: this.#webhookState.keyErrorMessage ?? WEBHOOK_UNAVAILABLE_MESSAGE,
    });
  }

  /** 直近結果は通常通知とテストで共通の 1 件。送信開始の世代で新しい方を優先する */
  #record(generation: number, result: NotificationResult): void {
    if (this.#closed || generation !== this.#generation) return;
    try {
      this.#db.saveNotificationSettings({ ...this.#read(), lastResult: result });
    } catch (error) {
      console.warn(`[u7agent] 通知の直近結果を保存できません: ${this.#mask(messageFor(error))}`);
    }
  }

  #read(): NotificationSettingsRow {
    return (
      this.#db.getNotificationSettings() ?? {
        enabled: false,
        askUser: true,
        webhook: null,
        baseUrl: null,
        lastResult: null,
      }
    );
  }

  /** 復号済みの URL。無いときは保存済みの URL を使えない理由を 503 で返す */
  #requireWebhook(): string {
    if (this.#webhookUrl) return this.#webhookUrl;
    throw httpError(
      503,
      this.#webhookState.keyErrorMessage ??
        (this.#cipher ? WEBHOOK_UNAVAILABLE_MESSAGE : APP_SECRET_MASTER_KEY_MESSAGE),
    );
  }

  #requireCipher(): AppSecretCipher {
    if (!this.#cipher) throw httpError(503, APP_SECRET_MASTER_KEY_MESSAGE);
    return this.#cipher;
  }

  #mask(text: string): string {
    return maskWebhook(this.#masker.mask(text), this.#knownUrls);
  }

  #remember(webhookUrl: string): void {
    this.#knownUrls = [webhookUrl, ...this.#knownUrls.filter((url) => url !== webhookUrl)].slice(0, MAX_KNOWN_URLS);
  }
}

/** テスト送信の本文。実通知と区別できるようにする */
function testPayload(): unknown {
  return {
    embeds: [
      {
        title: "🧪 テスト通知  u7agent",
        description: "このメッセージは設定の「テスト送信」から送信されました。\nWebhook URL は正常に動作しています。",
      },
    ],
  };
}
