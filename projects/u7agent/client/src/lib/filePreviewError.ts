import { isCommonSkillPath } from "./fileRef";

const MISSING_FILE_HINT = "共通スキル配下のファイルは 設定 → スキル から開けます。";

/**
 * プレビューの失敗に添える補助文。共通スキルへ誘導する案内は、**失敗したファイルが共通スキル配下の
 * ときだけ**出す (作業フォルダ側の `<cwd>/AGENTS.md` などに、その面に合わない案内を出さない)。
 * path は GET /api/files と同じワークスペース root 相対で、プレビューの fetchPath を渡す。
 */
export function filePreviewErrorHint(error: string, path: string): string | undefined {
  if (!error.startsWith("Path not found:")) return undefined;
  return isCommonSkillPath(path) ? MISSING_FILE_HINT : undefined;
}
