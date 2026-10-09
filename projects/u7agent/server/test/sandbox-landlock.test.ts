// Landlock ラッパーの解決と `--abi` 診断を、一時ディレクトリの偽ラッパーだけで検証する。
// 実カーネルの ABI には依存せず、利用不可の理由分類と fail-closed の境界を固定する。

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fixedLandlockWriteRoots,
  LANDLOCK_MIN_ABI,
  landlockRulesEnv,
  landlockUnavailableMessage,
  probeLandlockStatus,
  resolveLandlockWrapper,
} from "../src/sandbox/landlock";

const HAS_SH = existsSync("/bin/sh");

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeWrapper(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

test("resolves the wrapper only from the trusted dirs", { skip: !HAS_SH }, () => {
  const trusted = tempDir("pi-landlock-trusted-");
  const fake = tempDir("pi-landlock-fake-");
  const wrapper = writeWrapper(trusted, "u7agent-landlock", "echo 3");
  assert.equal(resolveLandlockWrapper([trusted]), wrapper);
  assert.equal(resolveLandlockWrapper([fake]), undefined);
  // 信頼ディレクトリの外へ解決する symlink は使わない (実体で判定する)
  symlinkSync(wrapper, join(fake, "u7agent-landlock"));
  assert.equal(resolveLandlockWrapper([fake]), undefined);
});

test("reports wrapper_missing without a wrapper and probe_failed when the probe cannot run", async () => {
  assert.deepEqual(await probeLandlockStatus(undefined), {
    state: "unavailable",
    abi: null,
    minAbi: LANDLOCK_MIN_ABI,
    reason: "wrapper_missing",
  });
  const missing = await probeLandlockStatus(join(tempDir("pi-landlock-missing-"), "u7agent-landlock"));
  assert.equal(missing.reason, "probe_failed");
});

test("maps the ABI output to enabled / unsupported / abi_unsupported", { skip: !HAS_SH }, async () => {
  const dir = tempDir("pi-landlock-abi-");
  const enabled = await probeLandlockStatus(writeWrapper(dir, "enabled", `echo ${LANDLOCK_MIN_ABI}`));
  assert.deepEqual(enabled, { state: "enabled", abi: LANDLOCK_MIN_ABI, minAbi: LANDLOCK_MIN_ABI });

  // カーネル非対応はラッパーが 0 を返す (終了コードは 0)
  const unsupported = await probeLandlockStatus(writeWrapper(dir, "unsupported", "echo 0"));
  assert.equal(unsupported.state, "unavailable");
  assert.equal(unsupported.reason, "unsupported");

  const oldAbi = await probeLandlockStatus(writeWrapper(dir, "old", `echo ${LANDLOCK_MIN_ABI - 1}`));
  assert.equal(oldAbi.reason, "abi_unsupported");
  assert.equal(oldAbi.abi, LANDLOCK_MIN_ABI - 1);
});

test("treats a failing, garbage, or hanging probe as probe_failed", { skip: !HAS_SH }, async () => {
  const dir = tempDir("pi-landlock-bad-");
  for (const body of ["exit 1", "echo not-a-number", "echo -1"]) {
    const status = await probeLandlockStatus(writeWrapper(dir, `bad-${body.replace(/\W/g, "")}`, body));
    assert.equal(status.state, "unavailable", body);
    assert.equal(status.reason, "probe_failed", body);
  }
  const hanging = await probeLandlockStatus(writeWrapper(dir, "hang", "sleep 30"));
  assert.deepEqual(hanging, {
    state: "unavailable",
    abi: null,
    minAbi: LANDLOCK_MIN_ABI,
    reason: "probe_failed",
  });
});

test("passes the rights and roots as JSON env and never falls back without a wrapper", () => {
  const env = landlockRulesEnv({
    shell: "/bin/bash",
    roots: [{ path: "/workspace/proj" }, { path: "/workspace/.agents/skills", create: true }],
  });
  assert.equal(env.U7AGENT_LANDLOCK_SHELL, "/bin/bash");
  assert.equal(env.U7AGENT_LANDLOCK_MIN_ABI, String(LANDLOCK_MIN_ABI));
  // 作業フォルダの環境変数からは U7AGENT_* を注入できないため、この env が上書きされる経路は無い
  assert.deepEqual(JSON.parse(env.U7AGENT_LANDLOCK_RULES), [
    { path: "/workspace/proj", create: false },
    { path: "/workspace/.agents/skills", create: true },
  ]);

  for (const status of [
    { state: "unavailable", abi: null, minAbi: LANDLOCK_MIN_ABI, reason: "wrapper_missing" } as const,
    { state: "unavailable", abi: null, minAbi: LANDLOCK_MIN_ABI, reason: "unsupported" } as const,
    { state: "unavailable", abi: 2, minAbi: LANDLOCK_MIN_ABI, reason: "abi_unsupported" } as const,
    { state: "unavailable", abi: null, minAbi: LANDLOCK_MIN_ABI, reason: "probe_failed" } as const,
  ]) {
    assert.ok(landlockUnavailableMessage(status).length > 0, status.reason);
  }

  const home = tempDir("pi-landlock-home-");
  const roots = fixedLandlockWriteRoots(home);
  const paths = roots.map((root) => root.path);
  assert.ok(paths.includes("/tmp"));
  assert.ok(paths.includes("/dev/null"));
  assert.ok(paths.includes("/dev/shm"));
  assert.ok(paths.includes(join(home, ".cache")));
  assert.ok(paths.includes(join(home, ".npm")));
  assert.ok(paths.includes(join(home, ".local", "share", "pnpm")));
  assert.ok(!paths.includes(home), "$HOME 全体は許可しない");
});
