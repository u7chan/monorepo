/**
 * 共有（Cloudflare への公開）の除外名の検証。下書き・追加・削除はアーカイブの設定と同じ純関数
 * （lib/archiveSettings.ts）を使い、共有だけの規則（`index.html` は公開に必要なので除外できない）をここへ足す。
 * 名前は全階層一致なので、許可すると入れ子の `index.html` も落とせてしまう。
 */
import { validateExcludeNames, type ArchiveSettingsDraft } from "./archiveSettings";

export const SHARED_CONTENT_INDEX_ERROR = "index.html は公開に必要なため除外できません";

/** 保存前の検証。1 セグメント名の規則・件数上限はアーカイブと同じで、`index.html` だけ追加で拒否する */
export function validateSharedContentExcludeNames(
  draft: ArchiveSettingsDraft,
  maxNames: number,
  maxNameLength: number,
): string | undefined {
  const reason = validateExcludeNames(draft, maxNames, maxNameLength);
  if (reason) return reason;
  return draft.excludeNames.includes("index.html") ? SHARED_CONTENT_INDEX_ERROR : undefined;
}
