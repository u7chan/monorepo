/**
 * チャットの添付ファイル。本文へ画像を混ぜず (マルチモーダル注入はしない)、サンドボックスの
 * `uploads/` に置いたパスをプロンプト末尾の注記でモデルへ知らせる。組み立てと検証はここだけに置く。
 */
import { httpError } from "./http";
import { normalizeWorkspacePath } from "./projects";

export const UPLOADS_DIR = "uploads";
/** 1 メッセージに添付できる件数。サンドボックスの保存名と違い、ここはリクエストの契約。 */
export const MAX_ATTACHMENTS = 10;
/** 1 ファイルの上限 (100 MiB)。クライアントとサンドボックスも同じ値で検査する。 */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

const ATTACHED_FILES_OPEN = "<attached_files>";
const ATTACHED_FILES_CLOSE = "</attached_files>";

/** 添付パス (作業フォルダ相対) を検証し、正規化した形で返す。uploads/ 配下だけを許可する。 */
export function normalizeAttachmentPaths(values: unknown): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw httpError(400, "attachments must be an array");
  if (values.length > MAX_ATTACHMENTS) {
    throw httpError(400, `attachments must be at most ${MAX_ATTACHMENTS} items`);
  }
  return values.map((value) => {
    if (typeof value !== "string") throw httpError(400, "attachments must be strings");
    let normalized: string;
    try {
      normalized = normalizeWorkspacePath(value);
    } catch {
      throw httpError(400, `Invalid attachment path: ${value}`);
    }
    if (!normalized.startsWith(`${UPLOADS_DIR}/`)) {
      throw httpError(400, `Attachment must be under ${UPLOADS_DIR}/: ${value}`);
    }
    return normalized;
  });
}

/** 本文末尾に足す注記。モデルが `read` で開けるよう、作業フォルダ相対 (`./uploads/…`) で示す。 */
export function composePrompt(text: string, attachments: string[]): string {
  if (attachments.length === 0) return text;
  const note = [ATTACHED_FILES_OPEN, ...attachments.map((path) => `- ./${path}`), ATTACHED_FILES_CLOSE].join("\n");
  return text ? `${text}\n\n${note}` : note;
}

/** 注記を除いた本文。title のように「ユーザーが打った文」だけを使いたい箇所から呼ぶ。 */
export function stripAttachedFiles(text: string): string {
  const split = splitAttachedFiles(text);
  return split ? split.text : text;
}

/**
 * 末尾の注記を本文と分ける。注記が無ければ undefined を返す。クライアント側の同名関数と
 * 同じ規則 (最後の 1 組だけを見て、本文末尾の空行も落とす) を保つ。
 */
export function splitAttachedFiles(text: string): { text: string; files: string[] } | undefined {
  const start = text.lastIndexOf(ATTACHED_FILES_OPEN);
  const end = text.lastIndexOf(ATTACHED_FILES_CLOSE);
  if (start === -1 || end <= start) return undefined;
  const files = text
    .slice(start + ATTACHED_FILES_OPEN.length, end)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ./"))
    .map((line) => line.slice(4));
  return { text: text.slice(0, start).replace(/\n+$/, ""), files };
}
