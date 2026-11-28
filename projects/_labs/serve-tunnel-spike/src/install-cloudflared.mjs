#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "2026.11.2";
/** GitHub のリリース asset の digest。取得時の TLS だけを信頼すると差し替えを見逃すため、固定値と比べる。 */
const SHA256 = {
  x64: "56f13335143ec0e22772963290683a84a04114a35ec64cbc794a4d39ff9bb8cf",
  arm64: "04a7b7f08bce85d56b26ffe1fdbfbb21a074495a363d16f0783c40e25b5c5281",
};

const projectDir = fileURLToPath(new URL("..", import.meta.url));
const dest = resolve(process.argv[2] ?? join(projectDir, "tools", "cloudflared"));

if (process.platform !== "linux") throw new Error(`unsupported platform: ${process.platform}`);
const arch = process.arch;
if (!SHA256[arch]) throw new Error(`unsupported architecture: ${arch}`);

const expected = SHA256[arch];
const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function installedVersion(path) {
  const installed = spawnSync(path, ["--version"], { encoding: "utf8" });
  return installed.status === 0 ? installed.stdout.trim() : "";
}

try {
  const current = await readFile(dest);
  if (digest(current) === expected && (await installedVersion(dest)).includes(VERSION)) {
    console.log(`cloudflared ${VERSION} is already installed at ${dest}`);
    process.exit(0);
  }
} catch {
  // 未導入・読めない場合は取り直す
}

const asset = `cloudflared-linux-${arch === "x64" ? "amd64" : "arm64"}`;
const url = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${asset}`;
const response = await fetch(url);
if (!response.ok) throw new Error(`failed to download ${asset}: HTTP ${response.status}`);
const binary = Buffer.from(await response.arrayBuffer());

const actual = digest(binary);
if (actual !== expected) {
  throw new Error(`sha256 mismatch for ${asset}: expected ${expected}, got ${actual}`);
}

await mkdir(dirname(dest), { recursive: true });
const partial = `${dest}.partial`;
await writeFile(partial, binary, { mode: 0o755 });
await chmod(partial, 0o755);
await rename(partial, dest);
await rm(partial, { force: true });

const version = await installedVersion(dest);
if (!version.includes(VERSION)) throw new Error(`installed cloudflared does not run: ${version || "no output"}`);
console.log(`installed ${version} to ${dest}`);
