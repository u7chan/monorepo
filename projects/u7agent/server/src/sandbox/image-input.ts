import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { messageFor, pathError } from "../errors";
import { fitsImageInputPixels, IMAGE_INPUT_MAX_BYTES, inspectImageInput } from "../image-format";
import { isInsideRoot } from "../path-strings";
import { joinRequestPath, realpathNative } from "./fs-path";
import { SANDBOX_MAX_IMAGE_INPUT_SCOPES } from "./protocol";

/**
 * 開いた実体の実パス。procfs 経由で fd の指す先を引き直し、解決から open までの差し替えを検出する。
 * 取得できないときは undefined を返し、呼び出し側が読み取りを拒む (実体を確かめられないまま読まない)。
 */
export async function openedFilePath(fd: number): Promise<string | undefined> {
  try {
    return await realpathNative(`/proc/self/fd/${fd}`);
  } catch {
    return undefined;
  }
}

/**
 * 参照画像の入力読取。公開 raw と違い拡張子 allowlist は通さず、実バイトで画像形式を決める。
 * 読める範囲は BFF が渡した scope (root 相対) の実パスだけで、検査後の差し替えも open 後に確かめる。
 */
export async function readScopedImageInput(
  rootCwd: string,
  requested: string,
  scopes: readonly string[],
  signal: AbortSignal | undefined,
  resolveOpenedPath: (fd: number) => Promise<string | undefined>,
): Promise<Buffer> {
  if (scopes.length === 0) throw pathError(400, "Image input requires a scope");
  if (scopes.length > SANDBOX_MAX_IMAGE_INPUT_SCOPES) {
    throw pathError(400, `Too many scopes (max ${SANDBOX_MAX_IMAGE_INPUT_SCOPES})`);
  }
  const root = await realpathNative(rootCwd).catch((error: unknown) => {
    throw pathError(500, `Cannot resolve the sandbox workspace: ${messageFor(error)}`);
  });
  const scopeRoots: string[] = [];
  for (const scope of scopes) {
    const resolved = await realpathNative(joinRequestPath(root, scope)).catch((error: NodeJS.ErrnoException) => {
      // 添付置き場はまだ無いことがある。実在しない範囲は無視し、他の失敗は 400 にする
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
      throw pathError(400, `Cannot resolve the image input scope: ${messageFor(error)}`);
    });
    if (!resolved) continue;
    if (!isInsideRoot(root, resolved, sep)) throw pathError(400, `Scope outside the workspace: ${resolved}`);
    scopeRoots.push(resolved);
  }
  if (scopeRoots.length === 0) throw pathError(400, "The image input scope does not exist");

  const candidate = resolve(root, requested || ".");
  const target = await realpathNative(joinRequestPath(root, requested)).catch((error: NodeJS.ErrnoException) => {
    if (!isInsideRoot(root, candidate, sep)) throw pathError(400, `Path outside the workspace: ${candidate}`);
    if (error.code === "ENOENT" || error.code === "ENOTDIR") throw pathError(404, `Path not found: ${candidate}`);
    throw pathError(400, `Cannot resolve path: ${messageFor(error)}`);
  });
  if (!isInsideRoot(root, target, sep)) throw pathError(400, `Path outside the workspace: ${target}`);
  if (!scopeRoots.some((scopeRoot) => isInsideRoot(scopeRoot, target, sep))) {
    throw pathError(400, `Path outside the image input scope: ${target}`);
  }

  if (signal?.aborted) throw pathError(400, "Image input read aborted");

  // 種別を確かめる前の blocking open を避けるため O_NONBLOCK を付ける (通常ファイルでは無効)。
  // これで writer のいない FIFO でも止まらず、open 後の fstat で非通常ファイルとして拒める。
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const nonBlock = constants.O_NONBLOCK ?? 0;
  const handle = await open(target, constants.O_RDONLY | noFollow | nonBlock).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ELOOP") throw pathError(400, `Symbolic links cannot be read: ${candidate}`);
    if (error.code === "ENOENT") throw pathError(404, `Path not found: ${candidate}`);
    throw pathError(400, `Cannot read the image input: ${messageFor(error)}`);
  });
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw pathError(400, `Not a regular file: ${candidate}`);
    // 実体の実パスを引き直せない = 差し替え・削除の競合下なので、範囲を確かめられないまま読まない
    const actual = await resolveOpenedPath(handle.fd);
    if (actual === undefined) throw pathError(400, "Cannot verify the opened image input");
    if (!isInsideRoot(root, actual, sep)) throw pathError(400, "The opened file left the workspace");
    if (!scopeRoots.some((scopeRoot) => isInsideRoot(scopeRoot, actual, sep))) {
      throw pathError(400, "The opened file left the image input scope");
    }
    if (stats.size > IMAGE_INPUT_MAX_BYTES) {
      throw pathError(413, `Image input is too large (max ${IMAGE_INPUT_MAX_BYTES} bytes)`);
    }
    // 宣言されたサイズで読み切れない / 増えている場合は途中の差し替えとして拒む
    const buffer = Buffer.alloc(stats.size + 1);
    let size = 0;
    while (size < buffer.length) {
      if (signal?.aborted) throw pathError(400, "Image input read aborted");
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size !== stats.size) throw pathError(400, "The image input changed while being read");
    const bytes = buffer.subarray(0, size);
    const format = inspectImageInput(bytes);
    if (!format) throw pathError(400, "Not a supported image (png / jpeg / webp only)");
    if (!fitsImageInputPixels(format.width, format.height)) {
      throw pathError(413, "Image input is too large (max 40 megapixels)");
    }
    return Buffer.from(bytes);
  } finally {
    await handle.close().catch(() => {});
  }
}
