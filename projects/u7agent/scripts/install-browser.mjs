#!/usr/bin/env node
/**
 * Playwright の chromium-headless-shell を固定して入れる。
 * 取得は playwright-core の CLI (`install chromium-headless-shell --only-shell`) に委ね、
 * 版の正本は playwright-core の browsers.json にする (独立した版定数を持たない)。
 * 同じ版が既にあれば再取得しない (コンテナ再作成でイメージの同梱物を取り直さない)。
 * 配布物の著作権表示 (ABOUT / LICENSE.headless_shell など) は取得物に含まれるので、そのまま残す。
 */
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Playwright が展開の完了を示すマーカー。これがあるディレクトリだけを取得済みとみなす */
const COMPLETE_MARKER = "INSTALLATION_COMPLETE";

/** 環境変数を優先し、未設定なら Playwright の既定キャッシュ (dev 用) を使う */
export function resolveBrowsersDir(env = process.env) {
  const configured = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (configured) {
    if (configured === "0") throw new Error("PLAYWRIGHT_BROWSERS_PATH=0 (node_modules 内への配置) は未対応です");
    return resolve(configured);
  }
  return env.HOME ? join(env.HOME, ".cache", "ms-playwright") : undefined;
}

/** ドライバの実体は server の依存として解決する (browsers.json が版の正本) */
export function playwrightCoreFiles() {
  const require = createRequire(join(ROOT, "server", "package.json"));
  const dir = dirname(require.resolve("playwright-core/package.json"));
  return { cliPath: join(dir, "cli.js"), browsersJsonPath: join(dir, "browsers.json") };
}

export function chromiumHeadlessShellRevision(browsersJson) {
  const browser = browsersJson.browsers?.find((entry) => entry.name === "chromium-headless-shell");
  if (!browser?.revision) throw new Error("browsers.json に chromium-headless-shell の revision がありません");
  return String(browser.revision);
}

/** Playwright が展開するディレクトリ名は `<name>-<revision>` の規則 */
export function headlessShellDir(browsersDir, revision) {
  return join(browsersDir, `chromium_headless_shell-${revision}`);
}

async function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

export async function installBrowser({ dest, log = () => {} } = {}) {
  const browsersDir = dest ? resolve(dest) : resolveBrowsersDir();
  if (!browsersDir) throw new Error("取得先を決められません (第 1 引数か PLAYWRIGHT_BROWSERS_PATH / HOME を指定する)");
  const { cliPath, browsersJsonPath } = playwrightCoreFiles();
  const revision = chromiumHeadlessShellRevision(JSON.parse(await readFile(browsersJsonPath, "utf8")));
  const installedDir = headlessShellDir(browsersDir, revision);
  if (await exists(join(installedDir, COMPLETE_MARKER))) {
    log(`chromium-headless-shell (rev ${revision}) は取得済みです: ${installedDir}`);
    return { browsersDir, revision, installed: false };
  }
  await mkdir(browsersDir, { recursive: true });
  log(`chromium-headless-shell (rev ${revision}) を取得します: ${browsersDir}`);
  const result = spawnSync(process.execPath, [cliPath, "install", "chromium-headless-shell", "--only-shell", "--no-progress"], {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersDir },
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`playwright install が失敗しました (${result.status ?? result.signal})`);
  if (!(await exists(join(installedDir, COMPLETE_MARKER)))) throw new Error(`取得後に ${installedDir} がありません`);
  return { browsersDir, revision, installed: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await installBrowser({ dest: process.argv[2], log: (message) => console.log(message) });
  console.log(`chromium-headless-shell (rev ${result.revision}) を ${result.browsersDir} で使えます`);
}
