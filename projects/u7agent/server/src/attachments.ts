/**
 * チャットの添付ファイル。本文へ画像を混ぜず (マルチモーダル注入はしない)、プロジェクトの
 * リポジトリ内にファイルを作らないよう、保存先は所属に関係なく `<appdir>/uploads/<sessionId>/` に
 * 統一する。モデルへはプロジェクトの cwd からでも開けるよう、注記で絶対パスを知らせる。
 * 組み立てと検証はここだけに置く。
 */
import { httpError } from "./http";
import { normalizeWorkspacePath } from "./projects";

/** 1 メッセージに添付できる件数。サンドボックスの保存名と違い、ここはリクエストの契約。 */
export const MAX_ATTACHMENTS = 10;
/** 1 ファイルの上限 (100 MiB)。クライアントとサンドボックスも同じ値で検査する。 */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

const ATTACHED_FILES_OPEN = "<attached_files>";
const ATTACHED_FILES_CLOSE = "</attached_files>";
const ATTACHMENT_LINE_PREFIX = "- ";

/**
 * 添付パス (root 相対) を検証し、正規化した形で返す。セッションの保存先
 * (`<appdir>/uploads/<sessionId>/`) の配下だけを許可する。セッションを跨いだ参照は 400 にする。
 */
export function normalizeAttachmentPaths(values: unknown, uploadsDirRel: string): string[] {
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
    if (!normalized.startsWith(`${uploadsDirRel}/`)) {
      throw httpError(400, `Attachment must be under ${uploadsDirRel}/: ${value}`);
    }
    return normalized;
  });
}

/** 本文末尾に足す注記。モデルが `read` で開けるよう、絶対パスで示す。 */
export function composePrompt(text: string, attachmentPaths: string[]): string {
  if (attachmentPaths.length === 0) return text;
  const note = [
    ATTACHED_FILES_OPEN,
    ...attachmentPaths.map((path) => `${ATTACHMENT_LINE_PREFIX}${path}`),
    ATTACHED_FILES_CLOSE,
  ].join("\n");
  return text ? `${text}\n\n${note}` : note;
}

/**
 * サンドボックスが返す root 相対パスを、セッションの保存先 (`<appdir>/uploads/<sessionId>/`)
 * 配下の添付として検証する。契約違反 (別ディレクトリ・`..`・絶対パス・ファイル名なし) は undefined。
 */
export function toAttachmentPath(uploadsDirRel: string, path: string): string | undefined {
  let normalized: string;
  try {
    normalized = normalizeWorkspacePath(path);
  } catch {
    return undefined;
  }
  if (!normalized.startsWith(`${uploadsDirRel}/`)) return undefined;
  // ファイル名が無い (ディレクトリを指す) 応答は添付にできない
  return normalized.length > uploadsDirRel.length + 1 ? normalized : undefined;
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
    .filter((line) => line.startsWith(ATTACHMENT_LINE_PREFIX))
    .map((line) => line.slice(ATTACHMENT_LINE_PREFIX.length));
  return { text: text.slice(0, start).replace(/\n+$/, ""), files };
}
