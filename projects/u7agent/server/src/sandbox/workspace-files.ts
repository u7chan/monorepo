import type { Dirent, Stats } from "node:fs";
import { lstat, open, readdir, rename, rm, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { messageFor, pathError } from "../errors";
import {
  realpathNative,
  relativeToRoot,
  resolveWorkspaceDirectory,
  resolveWorkspaceEntry,
  workspaceEntryName,
} from "./fs-path";
import {
  isValidEntryName,
  SANDBOX_MAX_FILE_ENTRIES,
  SANDBOX_MAX_PREVIEW_BYTES,
  type SandboxFileEntry,
  type SandboxFileListing,
  type SandboxMoveResult,
  type SandboxRenameResult,
} from "./protocol";

export async function readWorkspacePreview(rootCwd: string, requested: string): Promise<string> {
  const { target } = await resolveWorkspaceDirectory(rootCwd, requested, false);
  return readBoundedText(target, SANDBOX_MAX_PREVIEW_BYTES, {
    tooLarge: "プレビューは2 MiB以下のファイルに対応しています",
    invalidUtf8: "UTF-8のテキストファイルのみプレビューできます",
    binary: "バイナリファイルはプレビューできません",
  });
}

export async function readBoundedText(
  target: string,
  limit: number,
  messages: { tooLarge: string; invalidUtf8: string; binary: string },
): Promise<string> {
  const handle = await open(target, "r");
  try {
    if (!(await handle.stat()).isFile()) throw pathError(400, "Not a regular file");
    // stat 時点のサイズだけに頼ると、その後の増大を止められない。
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit) throw pathError(400, messages.tooLarge);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
    } catch {
      throw pathError(400, messages.invalidUtf8);
    }
    // oxlint-disable-next-line no-control-regex -- バイナリ判定のため制御文字を検出する。
    if (/[\u0000-\u0008\u000e-\u001f]/u.test(text)) throw pathError(400, messages.binary);
    return text;
  } finally {
    await handle.close();
  }
}

export async function removeWorkspaceFile(rootCwd: string, requested: string): Promise<void> {
  const name = workspaceEntryName(requested);
  if (name === undefined) throw pathError(400, `Not a regular file: ${requested}`);
  const { target } = await resolveWorkspaceEntry(
    rootCwd,
    requested,
    name,
    "regular file",
    "Symbolic links cannot be deleted",
  );

  await unlink(target).catch((error: unknown) => {
    // lstat の直後に bash などが消した場合は目的を達しているため成功にする
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw pathError(400, `Cannot delete the file: ${messageFor(error)}`);
  });
}

export async function removeWorkspaceDirectory(rootCwd: string, requested: string, recursive: boolean): Promise<void> {
  const name = workspaceEntryName(requested);
  if (name === undefined) throw pathError(400, `Not a directory: ${requested}`);
  const { target } = await resolveWorkspaceEntry(
    rootCwd,
    requested,
    name,
    "directory",
    "Symbolic links cannot be deleted",
  );

  if (recursive) {
    // fs.rm は配下の symlink を辿らない (リンク先は削除しない)。
    await rm(target, { recursive: true }).catch((error: unknown) => {
      // lstat の直後に bash などが消した場合は目的を達しているため成功にする
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw pathError(400, `Cannot delete the directory: ${messageFor(error)}`);
    });
    return;
  }

  await rmdir(target).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    // 非空ディレクトリは recursive の明示が無い限り消さない (部分削除も起こさない)
    if (code === "ENOTEMPTY" || code === "EEXIST") throw pathError(400, `Directory is not empty: ${target}`);
    throw pathError(400, `Cannot delete the directory: ${messageFor(error)}`);
  });
}

export async function renameWorkspaceEntry(
  rootCwd: string,
  requested: string,
  name: string,
): Promise<SandboxRenameResult> {
  const currentName = workspaceEntryName(requested);
  if (currentName === undefined) throw pathError(400, `Not a file or directory: ${requested}`);
  const { parent, target } = await resolveWorkspaceEntry(
    rootCwd,
    requested,
    currentName,
    "file or directory",
    "Symbolic links cannot be renamed",
  );

  // 名前は 1 セグメントだけなので、親の実パスへ連結すれば root 内に収まる
  const nextPath = join(parent.target, name);
  // 大文字小文字だけの変更は許すが、symlink は実体が同じでも別のエントリなので上書きしない。
  const existing = await lstat(nextPath).catch(() => undefined);
  if (existing && (existing.isSymbolicLink() || (await realpathNative(nextPath).catch(() => undefined)) !== target)) {
    throw pathError(409, `Already exists: ${nextPath}`);
  }

  await rename(target, nextPath).catch((error: unknown) => {
    // lstat の直後に他の実行が消した場合は動かす対象が無い
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw pathError(404, `Path not found: ${target}`);
    throw pathError(400, `Cannot rename: ${messageFor(error)}`);
  });
  return { path: relativeToRoot(parent.root, nextPath), name };
}

export async function moveWorkspaceEntry(rootCwd: string, from: string, to: string): Promise<SandboxMoveResult> {
  const currentName = workspaceEntryName(from);
  if (currentName === undefined) throw pathError(400, `Not a file or directory: ${from}`);

  // 移動元を先に解決すると、名前の誤り (400) が移動元の不存在 (404) に隠れる。
  const nextName = workspaceEntryName(to);
  if (nextName === undefined || !isValidEntryName(nextName)) throw pathError(400, `Invalid name: ${to}`);

  const { target } = await resolveWorkspaceEntry(
    rootCwd,
    from,
    currentName,
    "file or directory",
    "Symbolic links cannot be moved",
  );

  // 移動先の親は root 内の実在ディレクトリ。無ければ呼び出し側が POST /v1/dirs で作ってから呼ぶ
  const nextParent = await resolveWorkspaceDirectory(rootCwd, dirname(to));
  const nextPath = join(nextParent.target, nextName);

  // 既存があっても実体が同じなら通す (リネームと同じ規則)。symlink は実体が同じでも上書きしない
  const existing = await lstat(nextPath).catch(() => undefined);
  if (existing && (existing.isSymbolicLink() || (await realpathNative(nextPath).catch(() => undefined)) !== target)) {
    throw pathError(409, `Already exists: ${nextPath}`);
  }

  await rename(target, nextPath).catch((error: unknown) => {
    // lstat の直後に他の実行が消した場合は動かす対象が無い
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw pathError(404, `Path not found: ${target}`);
    throw pathError(400, `Cannot move: ${messageFor(error)}`);
  });
  return { path: relativeToRoot(nextParent.root, nextPath) };
}

/**
 * root 相対の要求パスを解決して一覧を返す。root 内外は「`..` の有無」ではなく realpath で解決した実パスで判定するため、
 * root 外にある symlink (`../link-in` など) から root 内へ解決する要求も 200 になる。
 * エラー文言は SDK の ls ツールに寄せる (BFF はサンドボックスの文言をそのままクライアントへ返す)。
 */
export async function listWorkspaceDirectory(rootCwd: string, requested: string): Promise<SandboxFileListing> {
  const { root, target } = await resolveWorkspaceDirectory(rootCwd, requested);

  const dirents = await readdir(target, { withFileTypes: true }).catch((error: unknown) => {
    throw pathError(400, `Cannot read directory: ${messageFor(error)}`);
  });
  // 並び替え (ディレクトリ先 → ファイル) には実体の種別が要るため、先に symlink だけ辿る。
  // その stat は size / mtime に再利用し、下の走査で取る stat は打ち切り分だけに抑える。
  const candidates = await Promise.all(dirents.map((dirent) => classifyEntry(target, dirent)));
  candidates.sort(compareEntries);
  const truncated = candidates.length > SANDBOX_MAX_FILE_ENTRIES;

  const entries: SandboxFileEntry[] = [];
  for (const candidateEntry of candidates.slice(0, SANDBOX_MAX_FILE_ENTRIES)) {
    const entry: SandboxFileEntry = { name: candidateEntry.name, type: candidateEntry.type };
    if (candidateEntry.symlink) entry.symlink = true;
    // symlink は辿った先、それ以外は lstat。壊れた symlink は stat が無いので size / mtime を付けない
    const stats = candidateEntry.symlink
      ? candidateEntry.target
      : await lstat(join(target, candidateEntry.name)).catch(() => undefined);
    if (stats) {
      // size はファイルだけ。ディレクトリの size はファイルの内容量を表さない
      if (candidateEntry.type === "file") entry.size = stats.size;
      entry.mtime = Math.round(stats.mtimeMs);
    }
    entries.push(entry);
  }

  return {
    // 解決後の実ディレクトリを root 相対で返す (root 外の別名から解決した場合も root 内のパスになる)
    path: relativeToRoot(root, target),
    entries,
    truncated,
  };
}

/**
 * symlink は辿った先の種別に寄せる (壊れた symlink は file として出す)。
 * 辿った stat は一覧の mtime に再利用するため捨てずに返す (壊れた symlink は undefined)。
 */
async function classifyEntry(
  dirPath: string,
  dirent: Dirent,
): Promise<{ name: string; type: "file" | "dir"; symlink: boolean; target: Stats | undefined }> {
  const name = dirent.name;
  if (!dirent.isSymbolicLink()) {
    return { name, type: dirent.isDirectory() ? "dir" : "file", symlink: false, target: undefined };
  }
  const followed = await stat(join(dirPath, name)).catch(() => undefined);
  return { name, type: followed?.isDirectory() ? "dir" : "file", symlink: true, target: followed };
}

/** ディレクトリ先 → ファイル、各グループ内は大文字小文字を無視した昇順 (同順はコード順で安定させる)。 */
function compareEntries(a: { name: string; type: "file" | "dir" }, b: { name: string; type: "file" | "dir" }): number {
  if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
  const ignoringCase = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  if (ignoringCase !== 0) return ignoringCase;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
