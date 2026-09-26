// 実行環境の診断 (コマンド検出) を、一時ディレクトリの偽コマンドだけで検証する。
// 実コマンドは使わず、env / 絶対パス / symlink / タイムアウト / 出力上限 / 同時数を固定する。

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  probeSandboxRuntime,
  RUNTIME_PROBE_HOME,
  type RuntimeProbeCommand,
  type RuntimeProbeOptions,
} from "../src/sandbox/runtime-info";

const HAS_SH = existsSync("/bin/sh");
// 子プロセスのスクリプトは sleep / touch などを使うため、システムディレクトリを PATH に足す
const SYSTEM_DIRS = ["/bin", "/usr/bin"];
const probeTimeout = { perCommandTimeoutMs: 2000, totalTimeoutMs: 5000 } as const;

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 名前が衝突しないよう、テスト用のコマンド名は接頭辞を付ける */
function command(name: string, args: readonly string[] = []): RuntimeProbeCommand {
  return { name, args };
}

function writeScript(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

function probe(
  pathDirs: readonly string[],
  commands: readonly RuntimeProbeCommand[],
  options: RuntimeProbeOptions = {},
) {
  return probeSandboxRuntime(tempDir("pi-probe-root-"), {
    pathDirs,
    commands,
    ...probeTimeout,
    ...options,
  });
}

test(
  "detects allowlisted commands from the trusted dirs in order and skips missing ones",
  { skip: !HAS_SH },
  async () => {
    const trusted = tempDir("pi-probe-trusted-");
    writeScript(trusted, "rtprobe-alpha", "printf 'alpha 1.2.3\\n'");
    writeScript(trusted, "rtprobe-beta", "printf 'beta version 2.0.0-rc1\\n'");
    const result = await probe(
      [trusted, ...SYSTEM_DIRS],
      [command("rtprobe-alpha"), command("rtprobe-missing"), command("rtprobe-beta")],
    );
    assert.deepEqual(result.commands, [
      { name: "rtprobe-alpha", version: "1.2.3" },
      { name: "rtprobe-beta", version: "2.0.0" },
    ]);
    assert.equal(typeof result.environment.os, "string");
    assert.equal(typeof result.environment.arch, "string");
    assert.equal(typeof result.environment.user, "string");
    assert.equal(typeof result.environment.isRoot, "boolean");
    assert.match(result.environment.workspace, /pi-probe-root-/);
  },
);

test("ignores fake commands placed in the workspace and on PATH", { skip: !HAS_SH }, async () => {
  const trusted = tempDir("pi-probe-trusted-");
  const workspace = tempDir("pi-probe-workspace-");
  const fakeDir = tempDir("pi-probe-fake-");
  writeScript(trusted, "rtprobe-fake", "printf 'real 1.2.3\\n'");
  const workspaceMarker = join(workspace, "workspace-ran");
  const pathMarker = join(fakeDir, "path-ran");
  writeScript(workspace, "rtprobe-fake", `touch '${workspaceMarker}'; printf 'fake 9.9.9\\n'`);
  writeScript(fakeDir, "rtprobe-fake", `touch '${pathMarker}'; printf 'fake 8.8.8\\n'`);

  const previousPath = process.env.PATH;
  process.env.PATH = fakeDir;
  try {
    const result = await probeSandboxRuntime(workspace, {
      pathDirs: [trusted, ...SYSTEM_DIRS],
      commands: [command("rtprobe-fake")],
      ...probeTimeout,
    });
    assert.deepEqual(result.commands, [{ name: "rtprobe-fake", version: "1.2.3" }]);
    assert.equal(result.environment.workspace, workspace);
  } finally {
    process.env.PATH = previousPath;
  }
  assert.equal(existsSync(workspaceMarker), false, "workspace の偽コマンドを実行しない");
  assert.equal(existsSync(pathMarker), false, "PATH 上の偽コマンドを実行しない");
});

test("does not inherit the parent process env into the probe child", { skip: !HAS_SH }, async () => {
  const trusted = tempDir("pi-probe-trusted-");
  const dump = join(tempDir("pi-probe-dump-"), "env.txt");
  writeScript(trusted, "rtprobe-env", `env > '${dump}'; printf '1.2.3\\n'`);
  const secrets = {
    PI_SANDBOX_TOKEN: "sandbox-token-0123456789abcdef",
    OPENAI_API_KEY: "sk-do-not-leak",
    ANTHROPIC_API_KEY: "sk-ant-do-not-leak",
    NODE_OPTIONS: "--require /tmp/evil.js",
    LD_PRELOAD: "/tmp/evil.so",
    PYTHONPATH: "/workspace/evil",
    BASH_ENV: "/workspace/evil.sh",
  };
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(secrets)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    const result = await probeSandboxRuntime(tempDir("pi-probe-root-"), {
      pathDirs: [trusted, ...SYSTEM_DIRS],
      commands: [command("rtprobe-env")],
      ...probeTimeout,
    });
    assert.deepEqual(result.commands, [{ name: "rtprobe-env", version: "1.2.3" }]);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const childEnv = readFileSync(dump, "utf8");
  for (const key of Object.keys(secrets)) {
    assert.equal(childEnv.includes(`${key}=`), false, `${key} を子プロセスへ渡さない`);
  }
  assert.match(childEnv, new RegExp(`^HOME=${RUNTIME_PROBE_HOME}$`, "m"));
  assert.match(childEnv, new RegExp(`^PATH=${trusted}:`, "m"), "PATH は信頼ディレクトリだけで組む");
});

test("rejects a symlink whose real path is outside the trusted dirs", { skip: !HAS_SH }, async () => {
  const trusted = tempDir("pi-probe-trusted-");
  const outside = tempDir("pi-probe-outside-");
  const marker = join(outside, "ran");
  writeScript(outside, "rtprobe-link", `touch '${marker}'; printf '5.5.5\\n'`);
  symlinkSync(join(outside, "rtprobe-link"), join(trusted, "rtprobe-link"));

  const result = await probe([trusted, ...SYSTEM_DIRS], [command("rtprobe-link")]);
  assert.deepEqual(result.commands, []);
  assert.equal(existsSync(marker), false, "信頼ディレクトリの外へ解決する symlink は実行しない");
});

test("follows a symlink whose real path stays inside the trusted dirs", { skip: !HAS_SH }, async () => {
  const trusted = tempDir("pi-probe-trusted-");
  writeScript(trusted, "rtprobe-real", "printf '3.4.5\\n'");
  symlinkSync(join(trusted, "rtprobe-real"), join(trusted, "rtprobe-alias"));

  const result = await probe([trusted, ...SYSTEM_DIRS], [command("rtprobe-alias")]);
  assert.deepEqual(result.commands, [{ name: "rtprobe-alias", version: "3.4.5" }]);
});

test("rejects command names that are not a single path segment", { skip: !HAS_SH }, async () => {
  const trusted = tempDir("pi-probe-trusted-");
  writeScript(trusted, "rtprobe-ok", "printf '1.0.0\\n'");
  const result = await probe(
    [trusted, ...SYSTEM_DIRS],
    [command("../rtprobe-ok"), command("/bin/sh"), command("rtprobe ok"), command("rtprobe-ok")],
  );
  assert.deepEqual(result.commands, [{ name: "rtprobe-ok", version: "1.0.0" }]);
});

test("keeps a command with a null version when the output has no version", { skip: !HAS_SH }, async () => {
  const trusted = tempDir("pi-probe-trusted-");
  writeScript(trusted, "rtprobe-noversion", "printf 'no version here\\n'");
  const result = await probe([trusted, ...SYSTEM_DIRS], [command("rtprobe-noversion")]);
  assert.deepEqual(result.commands, [{ name: "rtprobe-noversion", version: null }]);
});

test("kills the whole process group when a command exceeds its deadline", { skip: !HAS_SH }, async () => {
  const trusted = tempDir("pi-probe-trusted-");
  const marker = join(tempDir("pi-probe-marker-"), "late");
  writeScript(trusted, "rtprobe-slow", `sleep 0.5; touch '${marker}'; printf '1.2.3\\n'`);
  const began = Date.now();
  const result = await probe([trusted, ...SYSTEM_DIRS], [command("rtprobe-slow")], {
    perCommandTimeoutMs: 50,
    totalTimeoutMs: 2000,
  });
  const elapsed = Date.now() - began;
  assert.deepEqual(result.commands, [{ name: "rtprobe-slow", version: null }]);
  assert.ok(elapsed < 1000, `期限で打ち切る (elapsed=${elapsed}ms)`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 700));
  assert.equal(existsSync(marker), false, "殺した子プロセスの孫 (sleep) も残さない");
});

test("kills a command that exceeds the output limit while streaming", { skip: !HAS_SH }, async () => {
  const trusted = tempDir("pi-probe-trusted-");
  const marker = join(tempDir("pi-probe-marker-"), "late");
  writeScript(
    trusted,
    "rtprobe-loud",
    `dd if=/dev/zero bs=1024 count=200 2>/dev/null | tr '\\0' 'a'; sleep 0.5; touch '${marker}'; printf '1.2.3\\n'`,
  );
  const began = Date.now();
  const result = await probe([trusted, ...SYSTEM_DIRS], [command("rtprobe-loud")], {
    perCommandTimeoutMs: 5000,
    totalTimeoutMs: 5000,
    maxOutputBytes: 4096,
  });
  const elapsed = Date.now() - began;
  assert.deepEqual(result.commands, [{ name: "rtprobe-loud", version: null }]);
  assert.ok(elapsed < 2000, `読み込み中の上限で打ち切る (elapsed=${elapsed}ms)`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 700));
  assert.equal(existsSync(marker), false);
});

test("bounds the whole probe with the total timeout", { skip: !HAS_SH }, async () => {
  const trusted = tempDir("pi-probe-trusted-");
  const names = Array.from({ length: 8 }, (_, index) => `rtprobe-total-${index}`);
  for (const name of names) writeScript(trusted, name, "sleep 5; printf '1.2.3\\n'");
  const began = Date.now();
  const result = await probe(
    [trusted, ...SYSTEM_DIRS],
    names.map((name) => command(name)),
    {
      perCommandTimeoutMs: 5000,
      totalTimeoutMs: 150,
      maxConcurrency: 4,
    },
  );
  const elapsed = Date.now() - began;
  assert.equal(result.commands.length, names.length, "存在は確認できたコマンドは version: null で残す");
  assert.deepEqual(
    result.commands.map((entry) => entry.version),
    names.map(() => null),
  );
  assert.ok(elapsed < 1500, `全体の期限で打ち切る (elapsed=${elapsed}ms)`);
});

test("limits the number of concurrently running commands", { skip: !HAS_SH }, async () => {
  const trusted = tempDir("pi-probe-trusted-");
  const slotDir = tempDir("pi-probe-slots-");
  const maxFile = join(slotDir, "max.txt");
  // 母数をあらかじめ作って固定する (初回の ls で作られると数え方がぶれる)
  writeFileSync(maxFile, "");
  const names = Array.from({ length: 6 }, (_, index) => `rtprobe-conc-${index}`);
  for (const name of names) {
    writeScript(
      trusted,
      name,
      `touch "${slotDir}/$$"; ls '${slotDir}' | wc -l >> '${maxFile}'; sleep 0.2; rm -f "${slotDir}/$$"; printf '1.0.0\\n'`,
    );
  }
  const result = await probe(
    [trusted, ...SYSTEM_DIRS],
    names.map((name) => command(name)),
    {
      perCommandTimeoutMs: 3000,
      totalTimeoutMs: 5000,
      maxConcurrency: 2,
    },
  );
  assert.equal(result.commands.length, names.length);
  const observed = readFileSync(maxFile, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => Number.parseInt(line, 10));
  // ファイル名の max.txt 自体も ls の件数に入るため、上限 + 1 を超えないことで判定する
  assert.ok(Math.max(...observed) <= 3, `同時実行は 2 以下 (observed=${observed.join(",")})`);
  assert.equal(Math.max(...observed), 3, "バッチ内は並列に動く");
});

test("reports the workspace root rather than the probe cwd", { skip: !HAS_SH }, async () => {
  const trusted = tempDir("pi-probe-trusted-");
  const root = tempDir("pi-probe-root-");
  mkdirSync(join(root, "nested"));
  const result = await probeSandboxRuntime(root, {
    pathDirs: [trusted, ...SYSTEM_DIRS],
    commands: [],
    cwd: join(root, "nested"),
    ...probeTimeout,
  });
  assert.equal(result.environment.workspace, root);
  assert.deepEqual(result.commands, []);
});
