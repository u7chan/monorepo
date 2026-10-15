// scripts/install-browser.mjs と scripts/install-browser-cli.mjs の契約を検証する。
// 版の正本は playwright-core の browsers.json、入口は cwd を変えず特殊文字を含むパスでも壊れない、
// の 2 点がずれると Dockerfile の probe (実ブラウザ起動) まで気付けないため、ここで固定する。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scripts = (name: string) => new URL(`../../scripts/${name}`, import.meta.url).href;
const installer = await import(scripts("install-browser.mjs"));
const cliInstaller = await import(scripts("install-browser-cli.mjs"));

/** 入口が `node` へ渡した argv / 環境変数 / cwd */
type EntryRun = { cwd: string; args: string[]; browsersPath: string | undefined };

/**
 * 入口を実際に shell で走らせ、`node` に置き換えた stub が記録した呼び出しを見る。
 * 生成した文字列ではなく観測できる渡り方 (argv / 環境変数 / cwd) を確かめるため、引用の表現に依存しない。
 */
async function runBrowserEntry({
  root,
  browsersPath,
  cwd,
  args = [],
  env = {},
}: {
  root: string;
  browsersPath?: string;
  cwd: string;
  args?: string[];
  env?: Record<string, string>;
}): Promise<EntryRun> {
  const base = await mkdtemp(join(tmpdir(), "u7agent-browser-entry-"));
  try {
    const bin = join(base, "bin");
    const record = join(base, "record");
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, "node"),
      `#!/bin/sh
{
  printf 'cwd\t%s\n' "$(pwd)"
  if [ -n "\${PLAYWRIGHT_BROWSERS_PATH+set}" ]; then printf 'browsers\t%s\n' "$PLAYWRIGHT_BROWSERS_PATH"; fi
  for arg in "$@"; do printf 'arg\t%s\n' "$arg"; done
} > '${record}'
`,
      { mode: 0o755 },
    );

    const entry = await cliInstaller.installBrowserCli({
      root,
      dest: join(base, "dest"),
      browsersPath,
      log: () => {},
    });
    const result = spawnSync(entry.path, args, {
      cwd,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, ...env },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `入口が失敗しました: ${result.stderr}`);

    const lines = (await readFile(record, "utf8")).split("\n").filter(Boolean);
    const field = (key: string) => lines.find((line) => line.startsWith(`${key}\t`))?.slice(key.length + 1);
    return {
      cwd: field("cwd") ?? "",
      args: lines.filter((line) => line.startsWith("arg\t")).map((line) => line.slice(4)),
      browsersPath: field("browsers"),
    };
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

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

/** 空白・単一引用符・`$`・バッククォート・`;` を含む名前。引用を外すと分割・展開・構文エラーのどれかが起きる */
const SPECIAL_DIR = "u7agent's $checkout `dir`; [1]";

test("入口は特殊文字を含む checkout でも loader と CLI を絶対パスで渡し、cwd を変えない", async () => {
  const base = await mkdtemp(join(tmpdir(), "u7agent-browser-root-"));
  try {
    const root = join(base, SPECIAL_DIR);
    const cwd = join(base, "work dir's");
    await mkdir(root);
    await mkdir(cwd);
    const run = await runBrowserEntry({ root, cwd });
    assert.deepEqual(run.args, [
      "--import",
      join(root, "server", "node_modules", "tsx", "dist", "loader.mjs"),
      join(root, "server", "src", "browser", "cli.ts"),
    ]);
    assert.equal(run.cwd, cwd);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("入口は引数を分割も展開もせずそのまま渡す", async () => {
  const base = await mkdtemp(join(tmpdir(), "u7agent-browser-root-"));
  try {
    const sentinel = join(base, "substituted");
    const args = ["--out", "my file's name.png", `$(touch ${sentinel})`, "*", "; rm -rf /", "-"];
    const run = await runBrowserEntry({ root: join(base, "checkout"), cwd: base, args });
    assert.deepEqual(run.args.slice(3), args);
    await assert.rejects(stat(sentinel), /ENOENT/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("イメージの入口は環境変数の既定を焼き込まない", async () => {
  const run = await runBrowserEntry({ root: "/app", cwd: tmpdir() });
  assert.deepEqual(run.args, [
    "--import",
    "/app/server/node_modules/tsx/dist/loader.mjs",
    "/app/server/src/browser/cli.ts",
  ]);
  assert.equal(run.browsersPath, undefined);

  const explicit = "/ms-playwright";
  const kept = await runBrowserEntry({ root: "/app", cwd: tmpdir(), env: { PLAYWRIGHT_BROWSERS_PATH: explicit } });
  assert.equal(kept.browsersPath, explicit);
});

test("dev の入口は未設定のときだけキャッシュを既定にする", async () => {
  const base = await mkdtemp(join(tmpdir(), "u7agent-browser-root-"));
  try {
    const sentinel = join(base, "substituted");
    const root = join(base, "checkout");
    const fallback = join(base, `cache's $dir\`; $(touch ${sentinel})`);

    const unset = await runBrowserEntry({ root, browsersPath: fallback, cwd: base });
    assert.equal(unset.browsersPath, fallback);
    const empty = await runBrowserEntry({
      root,
      browsersPath: fallback,
      cwd: base,
      env: { PLAYWRIGHT_BROWSERS_PATH: "" },
    });
    assert.equal(empty.browsersPath, fallback);

    const explicit = join(base, "explicit cache");
    const kept = await runBrowserEntry({
      root,
      browsersPath: fallback,
      cwd: base,
      env: { PLAYWRIGHT_BROWSERS_PATH: explicit },
    });
    assert.equal(kept.browsersPath, explicit);
    await assert.rejects(stat(sentinel), /ENOENT/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
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
