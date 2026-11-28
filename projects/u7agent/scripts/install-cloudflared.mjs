#!/usr/bin/env node
/**
 * 一時共有 (Quick Tunnel) の実体 `cloudflared` を、版と sha256 を固定して入れる (linux の amd64 / arm64)。
 * 版の更新は手動 (Dependabot の対象外)。手順と理由は docs/service-tunnel.md を参照する。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CLOUDFLARED_VERSION = "2026.11.2";
/** リリース asset の sha256。取得経路の TLS だけを信頼すると差し替えを見逃すため、固定値と照合する */
export const CLOUDFLARED_SHA256 = {
  x64: "56f13335143ec0e22772963290683a84a04114a35ec64cbc794a4d39ff9bb8cf",
  arm64: "04a7b7f08bce85d56b26ffe1fdbfbb21a074495a363d16f0783c40e25b5c5281",
};
const ASSET_ARCH = { x64: "amd64", arm64: "arm64" };

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

async function alreadyInstalled(target, expected) {
  try {
    return sha256Of(await readFile(target)) === expected && runVersion(target).includes(CLOUDFLARED_VERSION);
  } catch {
    return false;
  }
}

/**
 * `dest` は配置先のディレクトリ。同じ版が入っていれば取り直さない。
 * `fetchImpl` / `platform` / `arch` / `checksums` はテスト用の差し替え。
 */
export async function installCloudflared({
  dest,
  log = () => {},
  fetchImpl = fetch,
  platform = process.platform,
  arch = process.arch,
  checksums = CLOUDFLARED_SHA256,
} = {}) {
  if (!dest) throw new Error("配置先を決められません (HOME が未設定)");
  if (platform !== "linux") throw new Error(`unsupported platform: ${platform}`);
  const expected = checksums[arch];
  const assetArch = ASSET_ARCH[arch];
  if (!expected || !assetArch) throw new Error(`unsupported architecture: ${arch}`);

  const target = join(dest, "cloudflared");
  if (await alreadyInstalled(target, expected)) {
    log(`cloudflared ${CLOUDFLARED_VERSION} は配置済みです: ${target}`);
    return { path: target, installed: false };
  }

  const asset = `cloudflared-linux-${assetArch}`;
  const response = await fetchImpl(
    `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset}`,
  );
  if (!response.ok) throw new Error(`failed to download ${asset}: HTTP ${response.status}`);
  const binary = Buffer.from(await response.arrayBuffer());
  const actual = sha256Of(binary);
  if (actual !== expected) throw new Error(`sha256 mismatch for ${asset}: expected ${expected}, got ${actual}`);

  await mkdir(dest, { recursive: true });
  // 書き込み途中の実体を BFF が起動しないよう、同じディレクトリで rename して差し替える
  const partial = `${target}.partial-${process.pid}`;
  try {
    await writeFile(partial, binary, { mode: 0o755 });
    await chmod(partial, 0o755);
    await rename(partial, target);
  } finally {
    await rm(partial, { force: true });
  }

  const version = runVersion(target);
  if (!version.includes(CLOUDFLARED_VERSION)) {
    throw new Error(`installed cloudflared is not runnable: ${version || "no output"}`);
  }
  log(`cloudflared を配置しました: ${target} (${version.split("\n")[0]})`);
  return { path: target, installed: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dest = process.argv[2] ? resolve(process.argv[2]) : devCloudflaredInstallDir();
  await installCloudflared({ dest, log: (message) => console.log(message) });
}
