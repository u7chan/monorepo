#!/usr/bin/env node
/**
 * 一時共有 (Quick Tunnel) の実体 `cloudflared` を、版と sha256 を固定して入れる (linux の amd64 / arm64)。
 * 版の更新は手動 (Dependabot の対象外)。手順と理由は docs/service-tunnel.md を参照する。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { open, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { agentWritableRoots, isAgentWritablePath } from "../server/src/agent-write-roots.ts";

export const CLOUDFLARED_VERSION = "2026.11.2";
/** リリース asset の sha256。取得経路の TLS だけを信頼すると差し替えを見逃すため、固定値と照合する */
export const CLOUDFLARED_SHA256 = {
  x64: "56f13335143ec0e22772963290683a84a04114a35ec64cbc794a4d39ff9bb8cf",
  arm64: "04a7b7f08bce85d56b26ffe1fdbfbb21a074495a363d16f0783c40e25b5c5281",
};
const ASSET_ARCH = { x64: "amd64", arm64: "arm64" };
/** 別プロセスのインストールを待つ上限と、止まったままのロックを外すまでの時間 */
const LOCK_WAIT_MS = 60_000;
const LOCK_STALE_MS = 10 * 60_000;
const LOCK_POLL_MS = 50;

/**
 * dev の配置先。BFF の探索先 (server/src/cloudflared.ts) と揃える。
 * サンドボックスの PATH に足す `u7agent` とは別にして、エージェントが名前で呼べないようにする。
 */
export function devCloudflaredInstallDir(home = process.env.HOME) {
  return home ? join(home, ".local", "libexec", "u7agent-bff") : undefined;
}

function sha256Of(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function runVersion(path) {
  const result = spawnSync(path, ["--version"], { encoding: "utf8" });
  return result.status === 0 ? `${result.stdout}${result.stderr}`.trim() : "";
}

async function alreadyInstalled(target, expected, verifyVersion) {
  try {
    return sha256Of(await readFile(target)) === expected && (await verifyVersion(target)).includes(CLOUDFLARED_VERSION);
  } catch {
    return false;
  }
}

/** 検証と配置を、同じ配置先を使う別プロセスとも直列にする。片方の削除が、もう片方の公開を消さないため */
async function withInstallLock(dest, run) {
  const lock = join(dest, ".install.lock");
  const started = Date.now();
  for (;;) {
    try {
      const handle = await open(lock, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
        return await run();
      } finally {
        await handle.close().catch(() => {});
        await rm(lock, { force: true }).catch(() => {});
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const info = await stat(lock).catch(() => undefined);
      if (!info) continue;
      if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(lock, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`配置先のロックを取れません: ${lock}`);
      await sleep(LOCK_POLL_MS);
    }
  }
}

/**
 * `dest` は配置先のディレクトリ。同じ版が入っていれば取り直さない。
 * `fetchImpl` / `platform` / `arch` / `checksums` / `verifyVersion` / `agentWritable` はテスト用の差し替え。
 * `agentWritable` はエージェントの bash が書ける root で、ここに入る場所は検証にも実行にも使わない。
 */
export async function installCloudflared({
  dest,
  rootCwd,
  home = process.env.HOME,
  writeRoots,
  log = () => {},
  fetchImpl = fetch,
  platform = process.platform,
  arch = process.arch,
  checksums = CLOUDFLARED_SHA256,
  verifyVersion = runVersion,
} = {}) {
  if (!dest) throw new Error("配置先を決められません (HOME が未設定)");
  if (platform !== "linux") throw new Error(`unsupported platform: ${platform}`);
  const expected = checksums[arch];
  const assetArch = ASSET_ARCH[arch];
  if (!expected || !assetArch) throw new Error(`unsupported architecture: ${arch}`);

  const target = join(dest, "cloudflared");
  const writable = agentWritableRoots({ rootCwd, home, fixed: writeRoots });
  const assertTrusted = () => {
    if (isAgentWritablePath(writable, dest) || isAgentWritablePath(writable, target)) {
      throw new Error(`配置先がエージェントの書き込める場所にあります: ${dest}`);
    }
  };
  assertTrusted();

  await mkdir(dest, { recursive: true });
  return withInstallLock(dest, async () => {
    // ロックを取るまでの間に差し替えられていないか、実在する形でもう一度見る
    assertTrusted();
    if (await alreadyInstalled(target, expected, verifyVersion)) {
      log(`cloudflared ${CLOUDFLARED_VERSION} は配置済みです: ${target}`);
      return { path: target, installed: false };
    }

    // 固定した版と合わない実体は先に外す。取り直しに失敗しても、BFF の既定の探索先に検証に落ちたものを残さない
    await rm(target, { force: true });

    const asset = `cloudflared-linux-${assetArch}`;
    const response = await fetchImpl(
      `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset}`,
    );
    if (!response.ok) throw new Error(`failed to download ${asset}: HTTP ${response.status}`);
    const binary = Buffer.from(await response.arrayBuffer());
    const actual = sha256Of(binary);
    if (actual !== expected) throw new Error(`sha256 mismatch for ${asset}: expected ${expected}, got ${actual}`);

    // 書き込み途中や動かない実体を BFF が起動しないよう、動くことを確かめてから、同じディレクトリで rename して公開する
    const partial = `${target}.partial-${process.pid}`;
    let version = "";
    try {
      await writeFile(partial, binary, { mode: 0o755 });
      await chmod(partial, 0o755);
      // 実行の直前にもう一度見る。検証と実行の間に差し替えられていないか
      assertTrusted();
      version = await verifyVersion(partial);
      if (!version.includes(CLOUDFLARED_VERSION)) {
        throw new Error(`downloaded cloudflared is not runnable: ${version || "no output"}`);
      }
      assertTrusted();
      await rename(partial, target);
    } finally {
      await rm(partial, { force: true });
    }
    log(`cloudflared を配置しました: ${target} (${version.split("\n")[0]})`);
    return { path: target, installed: true };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dest = process.argv[2] ? resolve(process.argv[2]) : devCloudflaredInstallDir();
  await installCloudflared({
    dest,
    rootCwd: process.env.PI_APP_CWD,
    log: (message) => console.log(message),
  });
}
