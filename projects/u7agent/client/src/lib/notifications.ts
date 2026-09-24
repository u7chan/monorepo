/**
 * 通知設定の下書き (PUT の body) と、テスト結果・プレビューの表示文言。DOM に依存しない純ロジックだけを置き、
 * 画面はここが返す値を描くだけにする (文言の出し分けをテストで固定するため)。
 */
import type { NotificationMention, NotificationResult, NotificationsResponse, UpdateNotificationsBody } from "../types";

export type NotificationDraft = {
  enabled: boolean;
  /** null = 保存済みを維持する。文字列は「変更」で入力した新しい値で、空文字は解除 (null 送信) を表す */
  webhookUrl: string | null;
  baseUrl: string;
  mention: NotificationMention;
};

/** 設定の読み込み前と下書きの破棄で使う初期値 */
export const EMPTY_NOTIFICATION_DRAFT: NotificationDraft = {
  enabled: false,
  webhookUrl: null,
  baseUrl: "",
  mention: "none",
};

/** 保存済みの設定から下書きを作る。URL は write-only なので常に空 (変更時にだけ入れ直す) */
export function draftFromSettings(settings: NotificationsResponse | null): NotificationDraft {
  return {
    enabled: settings?.enabled ?? false,
    webhookUrl: null,
    baseUrl: settings?.baseUrl ?? "",
    mention: settings?.mention ?? "none",
  };
}

/** 下書きが保存済みから変わっているか。[保存] の有効化と [破棄] の表示に使う */
export function draftIsDirty(draft: NotificationDraft, settings: NotificationsResponse | null): boolean {
  if (!settings) return false;
  return (
    draft.enabled !== settings.enabled ||
    // 保存済み URL は再表示しないため、入力が始まった時点で変更として扱う
    draft.webhookUrl !== null ||
    draft.baseUrl.trim() !== (settings.baseUrl ?? "") ||
    draft.mention !== settings.mention
  );
}

/**
 * 取得した設定に合わせて下書きを追従させる。他タブの保存や定期取得で `settings` が変わったとき、
 * **未編集のフィールドだけ**新しい保存値へ揃え、編集中のフィールドは残す
 * (未編集の古い値を PUT して、他タブの変更を巻き戻さないため)。
 * 判定は「下書きが直前の保存値と一致していれば未編集」。URL は write-only で比較できないため、
 * 入力中 (`null` 以外) は常に残す。
 */
export function syncDraft(
  draft: NotificationDraft,
  previous: NotificationsResponse | null,
  next: NotificationsResponse,
): NotificationDraft {
  if (!previous) return draftFromSettings(next);
  const base = draftFromSettings(previous);
  const updated = draftFromSettings(next);
  return {
    enabled: draft.enabled === base.enabled ? updated.enabled : draft.enabled,
    webhookUrl: draft.webhookUrl === null ? null : draft.webhookUrl,
    baseUrl: draft.baseUrl.trim() === base.baseUrl ? updated.baseUrl : draft.baseUrl,
    mention: draft.mention === base.mention ? updated.mention : draft.mention,
  };
}

/** PUT の body。webhookUrl は「変更」で入力したときだけ送り、空にすると null (解除) になる */
export function draftBody(draft: NotificationDraft): UpdateNotificationsBody {
  const body: UpdateNotificationsBody = {
    enabled: draft.enabled,
    mention: draft.mention,
    baseUrl: draft.baseUrl.trim() || null,
  };
  if (draft.webhookUrl !== null) body.webhookUrl = draft.webhookUrl.trim() || null;
  return body;
}

/** 未保存の URL 変更があり、保存後も URL が残る (テストできる) か。ボタンのラベルを決める */
export function testNeedsSave(draft: NotificationDraft): boolean {
  return draft.webhookUrl !== null && draft.webhookUrl.trim() !== "";
}

/** テスト送信できるか。未保存の変更があるときは保存後の値で判定する (解除したらテストできない) */
export function testAvailable(draft: NotificationDraft, settings: NotificationsResponse | null): boolean {
  if (draft.webhookUrl !== null) return draft.webhookUrl.trim() !== "";
  return settings?.configured === true;
}

/** ナビの ⚠ を出す条件。直近の送信が失敗しているときだけ */
export function notificationHasFailure(settings: NotificationsResponse | null): boolean {
  return settings?.lastResult?.ok === false;
}

/** 配信できない理由ごとの注記。色では表さず、バーの下へ文字で出す (導線は画面側が添える) */
export const NOTIFY_DISABLED_NOTE = "通知は設定で無効です";
export const NOTIFY_UNCONFIGURED_NOTE = "Webhook が未設定です";

/** 配信できない理由。disabled はグローバル無効、unconfigured は Webhook 未登録 */
export type NotifyUnavailableReason = "disabled" | "unconfigured";

/**
 * 配信できない理由。設定が未取得 (null) の間は判定できないため undefined を返し、注記も切替の禁止もしない
 * (起動直後の一瞬だけボタンが効かないと、壊れているように見える)。
 */
export function notifyUnavailableReason(settings: NotificationsResponse | null): NotifyUnavailableReason | undefined {
  if (!settings) return undefined;
  if (!settings.enabled) return "disabled";
  return settings.configured ? undefined : "unconfigured";
}

/**
 * バーの下へ出す注記。On で配信できないときは常に、まだ On でないときは押した後 (attempted) だけ出す
 * (設定が無効なだけの会話で毎回出して、バーを埋めないため)。
 */
export function notifyUnavailableNote(
  on: boolean,
  settings: NotificationsResponse | null,
  attempted = false,
): string | undefined {
  if (!on && !attempted) return undefined;
  const reason = notifyUnavailableReason(settings);
  if (!reason) return undefined;
  return reason === "disabled" ? NOTIFY_DISABLED_NOTE : NOTIFY_UNCONFIGURED_NOTE;
}

/**
 * 配信できる設定か。未取得 (null) の間は判定できないため true を返し、色とラベルを変えない。
 * On へ切り替えられるか (`notifyCannotEnable`) とは別物で、保存済みの On はここが false でも Off へは戻せる。
 */
export function notifyDeliverable(settings: NotificationsResponse | null): boolean {
  return notifyUnavailableReason(settings) === undefined;
}

/**
 * On へ切り替えられないか。Off へ戻す操作は常に許可する (機微な会話の通知を、設定を直すまで
 * 止められない状態を作らないため)。設定が未取得の間は判定しない。
 */
export function notifyCannotEnable(on: boolean, settings: NotificationsResponse | null): boolean {
  return !on && notifyUnavailableReason(settings) !== undefined;
}

/** 通知のリンク (`/s/<id>`) の会話を開けなかったときの注記 */
export const MISSING_LINK_NOTE = "リンク先の会話が見つかりませんでした。";

/** 会話を開く要求の結果。fallback は要求した会話を開けず、別の会話 / 未作成チャットへ移ったことを表す */
export type SessionOpenResult = "opened" | "fallback" | "superseded";

/**
 * リンク先を開けなかった理由を出すか。一覧に無い場合 (requested = false) だけでなく、一覧に載っていた会話が
 * 取得までに削除されていた場合 (GET が失敗して fallback した) にも出す。
 * 待機中にユーザーが別の会話を選んでいた (superseded) ときは、その選択を壊さず何も出さない。
 */
export function missingLinkNote(requested: boolean, opened: SessionOpenResult): string | undefined {
  if (opened === "superseded") return undefined;
  return !requested || opened === "fallback" ? MISSING_LINK_NOTE : undefined;
}

const RESULT_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  // 環境の時計設定 (12/24 時間) に左右されないよう h23 を明示する
  hourCycle: "h23",
};

/** 直近結果の日時。ja-JP の「2026/09/24 12:31」を、Issue の表記に合わせてハイフン区切りへ直す */
export function resultTimeLabel(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("ja-JP", { ...RESULT_TIME_FORMAT, timeZone }).format(at).replaceAll("/", "-");
}

const STATUS_LABELS: Record<number, string> = {
  200: "OK",
  204: "No Content",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/** 直近結果に出す「404 Not Found」。未知の status は数値だけにする (理由は headline 側で出す) */
export function httpStatusLabel(status: number): string {
  const label = STATUS_LABELS[status];
  return label ? `${status} ${label}` : String(status);
}

/** 直近結果の 1 行。応答が返らなかった (timeout / network) ときは status の代わりに理由を出す */
export function resultMetaLabel(result: NotificationResult, timeZone?: string): string {
  const status = result.status === undefined ? "送信できませんでした" : httpStatusLabel(result.status);
  // 既定は表示端末のローカル TZ。テストが表示を固定できるよう素通しする
  return `${resultTimeLabel(result.at, timeZone)} / ${status} / ${result.latencyMs} ms`;
}

export type NotificationResultView = {
  ok: boolean;
  /** 1 行目。Discord の message と code、または固定文言 */
  headline: string;
  /** 2 行目。次に何をすればよいか */
  detail?: string;
};

/**
 * 直近結果の文言。Discord の応答 (status / message / code) から出し分け、
 * リクエスト URL とレスポンス原文は出さない (サーバーも返さない)。
 */
export function notificationResultView(result: NotificationResult | undefined): NotificationResultView | null {
  if (!result) return null;
  if (result.ok) return { ok: true, headline: "送信できました。Discord のチャンネルを確認してください。" };
  const code = result.code === undefined ? "" : ` (code ${result.code})`;
  // 例外のメッセージはサーバー側の固定文言だけ (URL が混ざり得る原文は返らない)
  if (result.status === undefined) {
    return {
      ok: false,
      headline: result.message || "Discord へ接続できません。",
      detail: "BFF から外部 HTTPS に出られるか確認してください。",
    };
  }
  if (result.status === 401 || result.status === 403) {
    return { ok: false, headline: `${result.message || "Webhook のトークンが正しくないか、権限がありません"}${code}` };
  }
  if (result.status === 404) {
    return {
      ok: false,
      headline: `${result.message || "Webhook が見つかりません"}${code}`,
      detail: result.code === 10015 ? "URL が削除済みか、コピーが途中で切れています。" : undefined,
    };
  }
  if (result.status === 429) {
    return {
      ok: false,
      headline: `${result.message || "レート制限中です"}${code}`,
      detail:
        result.retryAfter === undefined
          ? "時間を置いて再試行してください。"
          : `Retry-After ${result.retryAfter} 秒待ってから再試行してください。`,
    };
  }
  if (result.status >= 500) {
    return {
      ok: false,
      headline: `${result.message || "Discord 側でエラーが発生しました"}${code}`,
      detail: "Discord 側の一時障害です。時間を置いて再試行してください。",
    };
  }
  return { ok: false, headline: `${result.message || `送信に失敗しました（HTTP ${result.status}）`}${code}` };
}

/** プレビューの見本。実データはサーバーが組み立てるため、形だけを Issue の例に揃える */
const PREVIEW_SESSION_ID = "a1b2c3d4e5";

/** プレビューのリンク行。ベース URL が空・不正なら undefined (サーバーもリンク行ごと出さない) */
export function previewLink(baseUrl: string): string | undefined {
  const value = baseUrl.trim();
  if (!value) return undefined;
  try {
    return new URL(`/s/${PREVIEW_SESSION_ID}`, value).href;
  } catch {
    return undefined;
  }
}

export function notificationPreviewLines(draft: NotificationDraft): string[] {
  const link = previewLink(draft.baseUrl);
  return [
    "✅ 完了  パンくずの折り返しを直す",
    "実装担当 ・ 4分12秒 ・ ツール 12件",
    "テストが 3 件失敗しています。修正して再実行してください。",
    ...(link ? [link] : []),
  ];
}
