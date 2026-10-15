#!/usr/bin/env node
/**
 * `u7agent-browser` の入口を trusted directory (`$HOME/.local/libexec/u7agent`) へ置く。
 * 入口は呼び出し元の cwd を変えず、tsx と CLI ソースを絶対パスで呼ぶ — `--import tsx` の解決は cwd に依存し、
 * 成果物の保存先 (cwd) を変えられないため。イメージは同じ雛形を `/usr/local/bin` へ置く
 * (`node scripts/install-browser-cli.mjs /app /usr/local/bin`)。
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BROWSER_CLI_NAME = "u7agent-browser";

/**
 * 入口の雛形。`root` はイメージなら /app、dev なら checkout の絶対パス。`browsersPath` を渡すと、
 * 未設定のときだけそれを使う (dev でサンドボックスの外から叩くときの既定。明示された値を優先する)。
 */
export function browserWrapperScript(root, browsersPath) {
  const fallback = browsersPath
    ? `if [ -z "\${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then PLAYWRIGHT_BROWSERS_PATH='${browsersPath}'; export PLAYWRIGHT_BROWSERS_PATH; fi\n`
    : "";
  return `#!/bin/sh
# 呼び出し元の cwd を保つ (成果物の保存先の基準)。tsx は絶対パスで呼ぶ。
${fallback}exec node --import ${join(root, "server", "node_modules", "tsx", "dist", "loader.mjs")} ${join(root, "server", "src", "browser", "cli.ts")} "$@"
`;
}

/** 配置先。イメージの /usr/local/bin と違い、dev は許可 root の外へ置く (実体を書き換えられないように) */
export function devBrowserCliDir(home = process.env.HOME) {
  return home ? join(home, ".local", "libexec", "u7agent") : undefined;
}

/** 内容が違うときだけ書き込む (毎回 chmod しても実害は無いが、mtime を動かさない) */
export async function installBrowserCli({ root = ROOT, dest = devBrowserCliDir(), browsersPath, log = () => {} } = {}) {
  if (!dest) throw new Error("HOME が未設定のため、入口の配置先を決められません");
  const target = join(dest, BROWSER_CLI_NAME);
  const content = browserWrapperScript(root, browsersPath);
  const existing = await readFile(target, "utf8").catch(() => undefined);
  if (existing !== content) {
    await mkdir(dest, { recursive: true });
    await writeFile(target, content, { mode: 0o755 });
    await chmod(target, 0o755);
    log(`u7agent-browser の入口を配置しました: ${target}`);
  }
  return { path: target };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await installBrowserCli({
    root: process.argv[2] ? resolve(process.argv[2]) : ROOT,
    dest: process.argv[3] ? resolve(process.argv[3]) : devBrowserCliDir(),
    log: (message) => console.log(message),
  });
  console.log(result.path);
}
