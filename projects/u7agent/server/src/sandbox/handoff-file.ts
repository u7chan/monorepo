import { randomUUID } from "node:crypto";
import { lstat, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { messageFor, pathError } from "../errors";
import type { KeyedSerialLock } from "../serial-lock";
import { resolveWorkspaceDirectory, workspaceEntryName } from "./fs-path";
import { SANDBOX_MAX_HANDOFF_BYTES, type SandboxHandoffRollback, type SandboxHandoffWrite } from "./protocol";
import { readBoundedText } from "./workspace-files";

/**
 * 引き継ぎメモの実パスを求める。親ディレクトリを realpath で検証し、最終要素は lstat で見て
 * symlink と通常ファイル以外を拒む (realpath で実体に解決すると root 外を読めてしまう)。
 * `existing` は最終要素が実在するか (読取りの 404 と書込みの新規作成の判定に使う)。
 * 不存在として扱うのは ENOENT だけで、権限エラーなどの lstat 失敗は呼び出し側へ伝播させ、
 * 下準備で「読み取れない」として拒否させる (読み取り不能を空の本文や新規作成として扱わない)。
 */
async function resolveHandoffPath(rootCwd: string, requested: string): Promise<{ target: string; existing: boolean }> {
  const name = workspaceEntryName(requested);
  if (name === undefined) throw pathError(400, `Not a regular file: ${requested}`);
  const parent = await resolveWorkspaceDirectory(rootCwd, dirname(requested));
  const target = join(parent.target, name);
  const stats = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw pathError(400, `Cannot inspect the handoff memo (${requested}): ${messageFor(error)}`);
  });
  if (stats?.isSymbolicLink()) throw pathError(400, `Symbolic links cannot be read or written: ${requested}`);
  if (stats && !stats.isFile()) throw pathError(400, `Not a regular file: ${requested}`);
  return { target, existing: stats !== undefined };
}

// HANDOFF.md の上限と文言はプレビューの変更に追随させない。
function readHandoffText(target: string): Promise<string> {
  return readBoundedText(target, SANDBOX_MAX_HANDOFF_BYTES, {
    tooLarge: "HANDOFF.md は 2 MiB 以下にしてください",
    invalidUtf8: "HANDOFF.md は UTF-8 のテキストファイルにしてください",
    binary: "バイナリの HANDOFF.md は扱えません",
  });
}

export async function readHandoffFile(rootCwd: string, requested: string): Promise<string> {
  const { target, existing } = await resolveHandoffPath(rootCwd, requested);
  if (!existing) throw pathError(404, `Path not found: ${requested}`);
  return readHandoffText(target);
}

/**
 * 引き継ぎメモを先頭へ追記する。既存の本文は解釈せず、先頭行に dedupeKey があるときだけ追記を省く
 * (同じ材料からの再試行で二重にしない)。書込みは一時ファイル + rename で原子的にする。
 */
export async function writeHandoffText(
  rootCwd: string,
  requested: string,
  section: string,
  dedupeKey: string,
  locks: KeyedSerialLock<string>,
): Promise<SandboxHandoffWrite> {
  const { target } = await resolveHandoffPath(rootCwd, requested);
  return locks.run(target, async () => {
    // 排他の先頭で読み直す (背後で進んだ他の追記の上へ重ね、上限も全文で判定する)
    const { existing } = await resolveHandoffPath(rootCwd, requested);
    const current = existing ? await readHandoffText(target) : undefined;
    const firstLine = current === undefined ? "" : (current.split("\n", 1)[0] ?? "");
    if (dedupeKey !== "" && firstLine.includes(dedupeKey)) {
      return { path: requested, written: false, created: false };
    }
    // 事前判定の後に他の追記が入っていても、追記後の全文を上限に収める (両方が 200 で超過するのを防ぐ)
    const total = Buffer.byteLength(current ?? "", "utf8") + Buffer.byteLength(section, "utf8");
    if (total > SANDBOX_MAX_HANDOFF_BYTES) {
      throw pathError(400, "HANDOFF.md は 2 MiB 以下にしてください");
    }
    const temp = join(dirname(target), `.pi-handoff-${randomUUID()}.part`);
    try {
      await writeFile(temp, `${section}${current ?? ""}`, { mode: 0o600 });
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw pathError(400, `Cannot write the handoff memo: ${messageFor(error)}`);
    }
    return { path: requested, written: true, created: !existing };
  });
}

/**
 * 新規作成した引き継ぎメモの取り消し。内容が `expected` と一致するときだけ削除する。照合から削除までを
 * 追記と同じ実パス排他の中で行い、背後で進んだ他の追記や編集を巻き戻さない。
 */
export async function rollbackHandoffText(
  rootCwd: string,
  requested: string,
  expected: string,
  locks: KeyedSerialLock<string>,
): Promise<SandboxHandoffRollback> {
  const { target } = await resolveHandoffPath(rootCwd, requested);
  return locks.run(target, async () => {
    const { existing } = await resolveHandoffPath(rootCwd, requested);
    if (!existing) return { deleted: false };
    // 照合できない (上限・形式・読取り失敗) ときは消さない。他の追記を巻き戻す側に倒さない
    const current = await readHandoffText(target).catch(() => undefined);
    if (current !== expected) return { deleted: false };
    await unlink(target);
    return { deleted: true };
  });
}
