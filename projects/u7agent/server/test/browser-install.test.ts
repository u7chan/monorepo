// scripts/install-browser.mjs と scripts/install-browser-cli.mjs の契約を検証する。
// 版の正本は playwright-core の browsers.json、入口は cwd を変えない、の 2 点がずれると
// Dockerfile の probe (実ブラウザ起動) まで気付けないため、ここで固定する。

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scripts = (name: string) => new URL(`../../scripts/${name}`, import.meta.url).href;
const installer = await import(scripts("install-browser.mjs"));
const cliInstaller = await import(scripts("install-browser-cli.mjs"));

test("取得先は環境変数を優先し、既定は Playwright のキャッシュ", () => {
  assert.equal(installer.resolveBrowsersDir({ PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright" }), "/ms-playwright");
  assert.equal(installer.resolveBrowsersDir({ HOME: "/home/example" }), "/home/example/.cache/ms-playwright");
  assert.equal(installer.resolveBrowsersDir({}), undefined);
  assert.throws(() => installer.resolveBrowsersDir({ PLAYWRIGHT_BROWSERS_PATH: "0" }), /未対応/);
});

test("ドライバの実体と版の正本を playwright-core から解決する", async () => {
  const files = installer.playwrightCoreFiles();
  await stat(files.cliPath);
  const browsersJson = JSON.parse(await readFile(files.browsersJsonPath, "utf8"));
  const revision = installer.chromiumHeadlessShellRevision(browsersJson);
  assert.match(revision, /^[0-9]+$/);
  assert.equal(
    revision,
    browsersJson.browsers.find((entry: { name: string }) => entry.name === "chromium-headless-shell").revision,
  );
  assert.equal(
    installer.headlessShellDir("/ms-playwright", revision),
    `/ms-playwright/chromium_headless_shell-${revision}`,
  );
  assert.throws(() => installer.chromiumHeadlessShellRevision({}), /revision/);
});

test("同じ版があるときは再取得しない", async () => {
  const dest = await mkdtemp(join(tmpdir(), "u7agent-browser-install-"));
  try {
    const files = installer.playwrightCoreFiles();
    const revision = installer.chromiumHeadlessShellRevision(
      JSON.parse(await readFile(files.browsersJsonPath, "utf8")),
    );
    const logs: string[] = [];
    await mkdir(join(installer.headlessShellDir(dest, revision)), { recursive: true });
    await writeFile(join(installer.headlessShellDir(dest, revision), "INSTALLATION_COMPLETE"), "");
    const result = await installer.installBrowser({ dest, log: (message: string) => logs.push(message) });
    assert.deepEqual(result, { browsersDir: dest, revision, installed: false });
    assert.equal(logs.length, 1, "取得済みであることを伝える");
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});

test("入口は呼び出し元の cwd を変えず、tsx と CLI を絶対パスで呼ぶ", async () => {
  const script = cliInstaller.browserWrapperScript("/app");
  assert.match(script, /^#!\/bin\/sh\n/);
  assert.match(
    script,
    /exec node --import \/app\/server\/node_modules\/tsx\/dist\/loader\.mjs \/app\/server\/src\/browser\/cli\.ts "\$@"/,
  );
  assert.ok(!script.includes("cd "), "cwd を変えない (成果物の保存先の基準になる)");
});

test("dev の入口は trusted directory へ実行可能な形で置く", async () => {
  const dest = await mkdtemp(join(tmpdir(), "u7agent-browser-cli-"));
  try {
    const result = await cliInstaller.installBrowserCli({ root: "/app", dest, log: () => {} });
    assert.equal(result.path, join(dest, "u7agent-browser"));
    const mode = (await stat(result.path)).mode;
    assert.ok(mode & 0o111, "実行ビットが立っている");
    assert.equal(await readFile(result.path, "utf8"), cliInstaller.browserWrapperScript("/app"));
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});
