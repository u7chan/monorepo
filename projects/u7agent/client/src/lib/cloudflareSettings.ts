/**
 * 設定 → 共有 → 接続 の下書きと接続確認。トークンは write-only なので、保存済みの値は常に空から始め、
 * 「変更するときだけ入力する」を型で表す。表示と保存の規則はこのファイルに閉じる。
 */
import type {
  CloudflareConnectionCheckResponse,
  CloudflareSettingsResponse,
  UpdateCloudflareSettingsBody,
} from "../types";
import type { ConfirmRequest } from "./confirmDialog";
import { messageFullTimeLabel, messageTimeLabel } from "./messageTime";

export interface CloudflareDraft {
  accountId: string;
  /** 空文字 = 保存済みを維持。新規登録では必須 (サーバーも 400 で拒否する) */
  apiToken: string;
}

export function cloudflareDraftFromSettings(settings: CloudflareSettingsResponse | null): CloudflareDraft {
  return { accountId: settings?.accountId ?? "", apiToken: "" };
}

/** アカウント ID は大文字小文字を無視して比べる (サーバーが小文字へ正規化する) */
export function cloudflareDraftDirty(draft: CloudflareDraft, settings: CloudflareSettingsResponse | null): boolean {
  const saved = settings?.accountId ?? "";
  return draft.accountId.trim().toLowerCase() !== saved.toLowerCase() || draft.apiToken.trim() !== "";
}

/** 保存要求。空のトークンは送らず、保存済みの暗号文を維持させる */
export function cloudflareSaveBody(draft: CloudflareDraft): UpdateCloudflareSettingsBody {
  const accountId = draft.accountId.trim();
  const apiToken = draft.apiToken.trim();
  return apiToken ? { accountId, apiToken } : { accountId };
}

/** 資格情報を消すと公開中の共有物を管理できなくなるため、対象を明示して確認する */
export function cloudflareDeleteConfirmRequest(): ConfirmRequest {
  return {
    kind: "confirm",
    title: "Cloudflare の資格情報を削除",
    subject: { label: "削除する接続", value: "Cloudflare" },
    body: [
      "保存済みの API トークンを復号できなくなります。公開を続けるには再登録が必要です。",
      "公開済みの共有コンテンツは削除されません。停止・再公開・削除には資格情報が要ります。",
    ],
    confirmLabel: "削除する",
    danger: true,
  };
}

export interface CloudflareCheckEnableInput {
  settings: CloudflareSettingsResponse;
  /** 下書きが保存値と違うか。下書きは入力欄の state なので呼び出し側が渡す */
  dirty: boolean;
  saving: "save" | "delete" | null;
  reloading: boolean;
  checking: boolean;
}

/** 「接続を確認」を押せるか。未登録・master key 不在・未保存の下書き・進行中の操作では押せない */
export function cloudflareCheckEnabled({ settings, dirty, saving, reloading, checking }: CloudflareCheckEnableInput) {
  return settings.configured && settings.available && !dirty && saving === null && !reloading && !checking;
}

/** カードに出す接続確認の結果。`pending` は確認中の 1 行だけを持つ */
export type CloudflareCheckDisplay =
  | { kind: "pending"; message: string }
  | { kind: "success"; message: string; time: string; fullTime: string }
  | { kind: "failure"; message: string; httpStatus: string | null }
  | { kind: "error"; message: string };

export interface CloudflareCheckDisplayInput {
  settings: CloudflareSettingsResponse;
  dirty: boolean;
  checking: boolean;
  result: CloudflareConnectionCheckResponse | null;
  /** 409 / 503 の固定文言。200 の結果とは別に持つ */
  error: string | null;
  /** テスト用。省略時は Date.now */
  now?: number;
}

/**
 * 結果行の出し分け。下書きが保存値と違う間は何も出さず（前回値の結果を今の入力の結果に見せない）、
 * 確認中に古い結果は出さない。アカウント ID が保存値と違う結果も捨てる。
 */
export function cloudflareCheckDisplay({
  settings,
  dirty,
  checking,
  result,
  error,
  now,
}: CloudflareCheckDisplayInput): CloudflareCheckDisplay | null {
  if (dirty) return null;
  if (error !== null) return { kind: "error", message: error };
  if (checking) return { kind: "pending", message: "接続を確認しています" };
  if (!result || result.accountId !== settings.accountId) return null;
  if (result.failure === null && result.subdomain) {
    return {
      kind: "success",
      message: `接続を確認できました。公開先のサブドメインは ${result.subdomain}.workers.dev です`,
      time: messageTimeLabel(result.checkedAt, { now }),
      fullTime: messageFullTimeLabel(result.checkedAt),
    };
  }
  return {
    kind: "failure",
    message: result.message ?? "Cloudflare へ接続できませんでした",
    httpStatus: cloudflareHttpStatusLabel(result.httpStatus),
  };
}

/** `HTTP <status>`。Cloudflare の 400 以上の status だけを添え、それ以外は出さない */
export function cloudflareHttpStatusLabel(httpStatus: number | null): string | null {
  return httpStatus !== null && httpStatus >= 400 ? `HTTP ${httpStatus}` : null;
}
