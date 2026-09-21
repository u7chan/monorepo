#!/usr/bin/env node
/**
 * コンテナ用に fd のリリースバイナリを固定して入れる。
 * Debian bookworm の fd-find (8.6.0) は pi SDK の find ツールが渡す --no-require-git (fd 9.0 で追加) を
 * 受け付けず、git 管理外のディレクトリで find が必ず失敗するため、apt の fd-find は使わない。
 * slim イメージに curl / wget が無いので fetch と tar だけで完結させる。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VERSION = "10.4.2";
/** v10.4.2 のリリース tar.gz の sha256 (musl 静的バイナリ) */
const SHA256 = {
  x64: "e3257d48e29a6be965187dbd24ce9af564e0fe67b3e73c9bdcd180f4ec11bdde",
  arm64: "f32d3657473fba74e2600babc8db0b93420d51169223b7e8143b2ed55d8fd9e8",
};

const dest = process.argv[2];
if (!dest) throw new Error("usage: node scripts/install-fd.mjs <dest-dir>");
if (process.platform !== "linux") throw new Error(`unsupported platform: ${process.platform}`);

const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch];
if (!arch) throw new Error(`unsupported architecture: ${process.arch}`);

const asset = `fd-v${VERSION}-${arch}-unknown-linux-musl.tar.gz`;
const response = await fetch(`https://github.com/sharkdp/fd/releases/download/v${VERSION}/${asset}`);
if (!response.ok) throw new Error(`failed to download ${asset}: HTTP ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());

const actual = createHash("sha256").update(archive).digest("hex");
if (actual !== SHA256[process.arch]) {
  throw new Error(`sha256 mismatch for ${asset}: expected ${SHA256[process.arch]}, got ${actual}`);
}

const work = await mkdtemp(join(tmpdir(), "install-fd-"));
const archivePath = join(work, asset);
await writeFile(archivePath, archive);
const extracted = spawnSync("tar", ["xzf", archivePath, "-C", work], { stdio: "pipe" });
if (extracted.status !== 0) {
  throw new Error(`failed to extract ${asset}: ${extracted.stderr?.toString().trim() || extracted.status}`);
}

const binary = join(dest, "fd");
await mkdir(dest, { recursive: true });
await copyFile(join(work, `fd-v${VERSION}-${arch}-unknown-linux-musl`, "fd"), binary);
await chmod(binary, 0o755);
await rm(work, { recursive: true, force: true });

const installed = spawnSync(binary, ["--version"], { encoding: "utf8" });
if (installed.status !== 0) throw new Error(`installed fd is not runnable: ${installed.stderr?.trim()}`);
console.log(`installed ${installed.stdout.trim()} to ${binary}`);
