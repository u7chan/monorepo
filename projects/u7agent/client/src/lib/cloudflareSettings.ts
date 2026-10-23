/**
 * 設定 → 共有 → 接続 の下書き。トークンは write-only なので、保存済みの値は常に空から始め、
 * 「変更するときだけ入力する」を型で表す。表示と保存の規則はこのファイルに閉じる。
 */
import type { CloudflareSettingsResponse, UpdateCloudflareSettingsBody } from "../types";
import type { ConfirmRequest } from "./confirmDialog";

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
