#!/usr/bin/env node
/**
 * dev 用に Landlock ラッパーを固定パス (`$HOME/.local/libexec/u7agent`) へ配置する。
 * イメージの `/usr/local/bin` は Dockerfile が配置する。`pnpm dev` が起動時に呼び、単体でも実行できる。
 * リポジトリ配下に置くと未所属セッションの作業領域 (root) 経由で書き換えられ得るため、許可 root の外へ置く。
 */
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shellQuote } from "./shell-quote.mjs";

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "landlock-exec.py");

/** 入口 (`/bin/sh`) と本体 (`python3` が読む実体) のファイル名 */
export const LANDLOCK_WRAPPER_NAME = "u7agent-landlock";
export const LANDLOCK_SCRIPT_NAME = "u7agent-landlock.py";

/** 配置先。ラッパーの探索先 (server/src/sandbox/landlock.ts) と揃える */
export function devLandlockInstallDir(home = process.env.HOME) {
  return home ? join(home, ".local", "libexec", "u7agent") : undefined;
}

/** python3 の実体。見つからなければ undefined (入口は実行時に PATH 上の python3 を探す) */
function pythonExecutable() {
  const probe = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
  if (probe.status !== 0) return undefined;
  return probe.stdout.trim() || undefined;
}

/**
 * 入口の雛形。python の実体を shebang に焼き込むと、パス中の空白で kernel が分割し、長さでも切り捨てられるため、
 * `/bin/sh` の入口から本体を exec で呼ぶ。本体をこのファイルへ埋め込む (heredoc) と呼び出し元の stdin を奪う。
 */
export function landlockWrapperScript(script, python) {
  return `#!/bin/sh
# 呼び出し元の cwd と stdin はそのまま渡す。本体は同じディレクトリの実体を絶対パスで呼ぶ。
exec ${python ? shellQuote(python) : "python3"} ${shellQuote(script)} "$@"
`;
}

/** 内容が違うときだけ書き込む (毎回 chmod しても実害は無いが、mtime を動かさない) */
async function writeIfChanged(path, content, mode) {
  const existing = await readFile(path, "utf8").catch(() => undefined);
  if (existing === content) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { mode });
  await chmod(path, mode);
  return true;
}

/**
 * 戻り値の python は入口に焼き込んだ実体で、undefined なら実行時に PATH 上の python3 に依存する。
 * `dest` / `python` は配置先と実体を差し替えるための入力 (テストと、許可 root の外へ置く呼び出し元のため)。
 */
export async function installLandlockWrapper({
  dest = devLandlockInstallDir(),
  python = pythonExecutable(),
  log = () => {},
} = {}) {
  if (!dest) throw new Error("HOME が未設定のため、Landlock ラッパーの配置先を決められません");
  const target = join(dest, LANDLOCK_WRAPPER_NAME);
  const script = join(dest, LANDLOCK_SCRIPT_NAME);
  const wroteScript = await writeIfChanged(script, await readFile(SOURCE, "utf8"), 0o644);
  const wroteWrapper = await writeIfChanged(target, landlockWrapperScript(script, python), 0o755);
  if (wroteWrapper || wroteScript) log(`Landlock ラッパーを配置しました: ${target}`);
  return { path: target, script, python };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await installLandlockWrapper({ log: (message) => console.log(message) });
  if (!result.python) {
    console.log("python3 が見つかりません。bash の実行には python3 が必要です");
  }
}
