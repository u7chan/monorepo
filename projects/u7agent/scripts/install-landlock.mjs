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

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "landlock-exec.py");

/** 配置先。ラッパーの探索先 (server/src/sandbox/landlock.ts) と揃える */
export function devLandlockInstallDir(home = process.env.HOME) {
  return home ? join(home, ".local", "libexec", "u7agent") : undefined;
}

/** python3 の実体。PATH 依存を残さないよう shebang に焼き込む (見つからなければ元の shebang のまま) */
function pythonExecutable() {
  const probe = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
  if (probe.status !== 0) return undefined;
  return probe.stdout.trim() || undefined;
}

/**
 * 配置先と内容が違うときだけ書き込む (毎回 chmod しても実害は無いが、mtime を動かさない)。
 * 戻り値の python は shebang に焼き込んだ実体で、undefined なら PATH 上の python3 に依存する。
 */
export async function installLandlockWrapper({ log = () => {} } = {}) {
  const home = devLandlockInstallDir();
  if (!home) throw new Error("HOME が未設定のため、Landlock ラッパーの配置先を決められません");
  const python = pythonExecutable();
  const source = await readFile(SOURCE, "utf8");
  const content = python ? source.replace(/^#!.*\n/, `#!${python}\n`) : source;
  const target = join(home, "u7agent-landlock");
  const existing = await readFile(target, "utf8").catch(() => undefined);
  if (existing !== content) {
    await mkdir(home, { recursive: true });
    await writeFile(target, content, { mode: 0o755 });
    await chmod(target, 0o755);
    log(`Landlock ラッパーを配置しました: ${target}`);
  }
  return { path: target, python };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await installLandlockWrapper({ log: (message) => console.log(message) });
  if (!result.python) {
    console.log("python3 が見つかりません。bash の実行には python3 が必要です");
  }
}
