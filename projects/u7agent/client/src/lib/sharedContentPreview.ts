/**
 * 共有ダイアログのプレビューの見せ方。件数はディレクトリも数えるため「ファイル数」と呼ばず、
 * 一覧の打ち切りと公開されないもの (symlink など) を注記として分ける。
 * 公開の確定はジョブの検証なので、ここでは「見え方」だけを作る。
 */
import type { SharedContentPreviewResponse } from "../types";

/** 一覧に並べる行数。全体の件数は `entries` で別に出す */
export const SHARE_PREVIEW_ROWS = 10;

/** 注記にパスを並べる上限。これを超えた分は件数だけを示す */
const NOTE_PATHS = 5;

/** サイズの表示。1 KiB 未満はバイトのまま、それ以上は 3 桁になるまで単位を上げる */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

export type SharePreviewSummary = {
  /** 件数と合計サイズの 1 行。上限超過で数えられないときは null */
  totals: string | null;
  /** 一覧に出す行 */
  rows: readonly { name: string; size: string }[];
  /** 表示の絞り込み・打ち切り・公開されないものの注記 */
  notes: readonly string[];
};

/** プレビューの応答を表示用へ写す。BFF の `problems` は文言をそのまま出し、ここでは作らない */
export function sharePreviewSummary(preview: SharedContentPreviewResponse): SharePreviewSummary {
  const rows = preview.files
    .slice(0, SHARE_PREVIEW_ROWS)
    .map((file) => ({ name: file.name, size: formatByteSize(file.size) }));
  const notes: string[] = [];
  // 除外は「何件落とす設定か」と「実際に落ちた名前」を分ける。skipped は走査で見つかった名前だけ
  if (preview.excludeNames.length > 0) {
    notes.push(`除外 ${preview.excludeNames.length} 件（設定 → 共有 → 公開の除外）`);
  }
  if (preview.skipped.length > 0) {
    const shown = preview.skipped.slice(0, NOTE_PATHS).join(", ");
    const rest = preview.skipped.length - NOTE_PATHS;
    notes.push(`除外した名前: ${shown}${rest > 0 ? ` ほか ${rest} 件` : ""}`);
  }
  if (preview.limited) {
    notes.push("上限を超えているため、一覧と index.html の有無を確認できませんでした。");
  }
  const totals =
    preview.limited || preview.entries === null || preview.bytes === null
      ? null
      : `${preview.entries.toLocaleString("en-US")} 件（ディレクトリを含む）・合計 ${formatByteSize(preview.bytes)}`;
  // 取得側の打ち切り (sandbox の上限) と、表示側の絞り込み (行数) は理由が違うので分けて出す
  if (preview.truncated) {
    notes.push(`一覧は先頭 ${preview.files.length} 件までしか取得できていません。`);
  }
  if (preview.files.length > rows.length) {
    const rest = preview.files.length - rows.length;
    notes.push(`一覧は先頭 ${rows.length} 件だけを表示しています（残り ${rest.toLocaleString("en-US")} 件）。`);
  }
  if (preview.links.length > 0) {
    const shown = preview.links.slice(0, NOTE_PATHS).join(", ");
    const rest = preview.links.length - NOTE_PATHS;
    notes.push(`symlink など公開されないもの: ${shown}${rest > 0 ? ` ほか ${rest} 件` : ""}`);
    if (preview.linksTruncated) notes.push("公開されないものは他にもあります。");
  }
  return { totals, rows, notes };
}
