/**
 * チャットの添付ファイル。注記の形式はサーバー (server/src/attachments.ts) と同じで、
 * ここは送信前の検査・チップの状態・履歴の分解だけを担う。DOM に依存しない純関数だけを置く。
 */

/** 1 メッセージに添付できる件数 (サーバーの MAX_ATTACHMENTS と同じ) */
export const MAX_ATTACHMENTS = 10;
/** 1 ファイルの上限 (100 MiB)。実際の最終判定は BFF / サンドボックス側で行う */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const MAX_ATTACHMENT_LABEL = "100 MiB";

/** raw 配信 (画像プレビュー) に対応する拡張子。SVG は同一オリジンでスクリプトが動くため含めない。 */
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"];

/**
 * raw 配信 (音声プレビュー) に対応する拡張子。再生できる形式はブラウザのコーデックに依るため、
 * ここではサーバーの allowlist と同じものを並べる (docs/api.md)。
 */
const AUDIO_EXTENSIONS = ["mp3", "m4a", "ogg", "oga", "wav", "flac"];

export type AttachmentStatus = "uploading" | "done" | "error";

export type Attachment = {
  id: string;
  /** アップロード先のセッション。切替時にチップを残さないための照合キー */
  sessionId: string;
  name: string;
  size: number;
  status: AttachmentStatus;
  /** 成功時の root 相対パス (`.u7agent/uploads/<sessionId>/…`) */
  path?: string;
  /** 失敗理由 (上限超過・件数超過・API エラー) */
  error?: string;
};

const ATTACHED_FILES_OPEN = "<attached_files>";
const ATTACHED_FILES_CLOSE = "</attached_files>";
const ATTACHMENT_LINE_PREFIX = "- ";

/** パスの最終セグメントの拡張子が一覧にあるか見る (内容は見ない)。拡張子なしとドットファイルは false。 */
function hasListedExtension(name: string, extensions: readonly string[]): boolean {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return extensions.includes(base.slice(dot + 1).toLowerCase());
}

/** 拡張子で画像か判定する (raw 配信の allowlist と同じ規則)。 */
export function isImageName(name: string): boolean {
  return hasListedExtension(name, IMAGE_EXTENSIONS);
}

/**
 * 拡張子で音声か判定する。`isImageName` と実装は同じでも allowlist は共有しない
 * (共有すると添付チップのサムネイル表示が音声へ広がり、`isImageName` の意味が変わるため)。
 */
export function isAudioName(name: string): boolean {
  return hasListedExtension(name, AUDIO_EXTENSIONS);
}

/** チップに出すサイズ表記。KB 以上は小数 1 桁で丸める。 */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * 現在のセッションのチップだけを返す。切替直後は effect の削除より先に描画されるため、
 * 古いセッションのチップをそのまま出すと前の作業フォルダを指す URL になる。
 */
export function attachmentsForSession(attachments: Attachment[], sessionId: string): Attachment[] {
  return attachments.filter((item) => item.sessionId === sessionId);
}

/**
 * 1 回の送信に載せる添付。`include = false`（失敗の再実行）ではチップを読まず、何も送らず消費もしない
 * （固定文言だけを送り、編集中の添付を巻き込まないため）。`pending` は送信を止める判定に使う。
 */
export function attachmentsForSend(
  attachments: Attachment[],
  sessionId: string,
  include: boolean,
): { pending: Attachment[]; paths: string[]; sentIds: string[] } {
  const pending = include ? attachmentsForSession(attachments, sessionId) : [];
  return {
    pending,
    paths: pending.map((item) => item.path).filter((path): path is string => Boolean(path)),
    sentIds: pending.map((item) => item.id),
  };
}

/** 追加前の検査。理由を返したらチップは error としてだけ残す (アップロードしない)。 */
export function attachmentRejection(file: { name: string; size: number }, currentCount: number): string | undefined {
  if (currentCount >= MAX_ATTACHMENTS) return `添付できるのは最大 ${MAX_ATTACHMENTS} 件までです`;
  if (file.size > MAX_ATTACHMENT_BYTES) return `${MAX_ATTACHMENT_LABEL} を超えるファイルは添付できません`;
  return undefined;
}

/**
 * 履歴の本文から末尾の注記を切り離す。サーバーが組み立てた注記だけを対象にし、
 * 本文に同じタグが入っていても最後の 1 組だけを見る。パスは注記どおり (絶対パス) を返す。
 */
export function splitAttachedFiles(text: string): { text: string; files: string[] } {
  const start = text.lastIndexOf(ATTACHED_FILES_OPEN);
  const end = text.lastIndexOf(ATTACHED_FILES_CLOSE);
  if (start === -1 || end <= start) return { text, files: [] };
  const files = text
    .slice(start + ATTACHED_FILES_OPEN.length, end)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(ATTACHMENT_LINE_PREFIX))
    .map((line) => line.slice(ATTACHMENT_LINE_PREFIX.length));
  return { text: text.slice(0, start).replace(/\n+$/, ""), files };
}

/**
 * 添付パスを raw 配信が受ける root 相対へ揃える。注記は絶対パス、アップロード直後のチップは
 * root 相対で届くため、両方を同じ形に寄せる (root の前置きが無ければそのまま root 相対とみなす)。
 */
export function attachmentFetchPath(rootCwd: string, path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const root = rootCwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root && normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  return normalized;
}
