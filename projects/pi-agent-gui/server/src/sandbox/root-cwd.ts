import { constants } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

export type RootCwdCheck = { ok: true; path: string } | { ok: false; message: string };

/**
 * 作業領域を用意する。Docker の既定 (/workspace) はイメージ契約として維持し、
 * 準備できないときだけホスト実行向けの案内へ落とす (生のスタックを見せない)。
 */
export async function prepareRootCwd(rootCwd: string): Promise<RootCwdCheck> {
  const path = resolve(rootCwd);
  try {
    await mkdir(path, { recursive: true });
    if (!(await stat(path)).isDirectory()) return { ok: false, message: failureMessage(path, "ENOTDIR") };
    // 既存ディレクトリの権限不足は mkdir が成功してしまうため、明示的に確認する。
    await access(path, constants.W_OK);
    return { ok: true, path };
  } catch (error) {
    return { ok: false, message: failureMessage(path, errorCode(error)) };
  }
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

/** 秘密値 (トークンなど) は載せず、対象パスとエラーコードだけを案内に出す。 */
function failureMessage(path: string, code: string): string {
  return [
    `作業領域を準備できませんでした: ${path} (${code})`,
    "ホストで起動するときは、書込み可能なディレクトリを PI_SANDBOX_CWD へ指定し、BFF の PI_APP_CWD と同じパスに揃えてください。",
    "例: PI_SANDBOX_CWD=$PWD pnpm start:sandbox",
    "Docker では書込み可能な作業領域を /workspace へマウントしてください (README「サンドボックスを分離して動かす」)。",
  ].join("\n");
}
