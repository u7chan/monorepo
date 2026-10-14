// 同梱先の既定 (server/src/browser/environment.ts) と、その設定が Playwright の読み込み前に効くこと
// (server/src/browser/session.ts の import 順序) を検証する。
// Playwright はモジュールの読み込み時に PLAYWRIGHT_BROWSERS_PATH から registry の位置を確定するため、
// import した後で環境変数を入れても遅い。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DEFAULT_BROWSERS_PATH, resolveBrowsersPath } from "../src/browser/environment";

const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
const PROBE = fileURLToPath(new URL("./browser-env-probe.ts", import.meta.url));

test("同梱先は明示された環境変数を優先し、未設定ならイメージの既定を使う", () => {
  assert.equal(DEFAULT_BROWSERS_PATH, "/ms-playwright");
  assert.equal(resolveBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: "/custom/browsers" }), "/custom/browsers");
  assert.equal(resolveBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: " /custom/browsers " }), "/custom/browsers");
  assert.equal(resolveBrowsersPath({}), DEFAULT_BROWSERS_PATH);
  assert.equal(resolveBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: "0" }), DEFAULT_BROWSERS_PATH);
});

/** session.ts を import しただけの子プロセスで、実際に効いている値を読む (import 順序の契約) */
function importedBrowsersPath(env: NodeJS.ProcessEnv): string {
  const result = spawnSync(process.execPath, ["--import", TSX_LOADER, PROBE], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("session の import 時点で未設定の既定が有効になる", () => {
  assert.equal(importedBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: "" }), DEFAULT_BROWSERS_PATH);
  assert.equal(importedBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: "/custom/browsers" }), "/custom/browsers");
});
