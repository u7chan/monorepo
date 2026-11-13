// アプリの global gitconfig（~/.config/u7agent/gitconfig）の準備と bash への適用。
// パス検証・原子的な書込・symlink 親の拒否は pure な準備関数で、identity の実効は実 bash + git で検証する。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { lstat, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { LANDLOCK_MIN_ABI, resolveLandlockWrapper } from "../src/sandbox/landlock";
import { GIT_CONFIG_FILENAME, gitConfigTarget, prepareGitConfig } from "../src/sandbox/git-config";
import { createSandboxService } from "../src/sandbox/service";
import type { SandboxEvent, SandboxRuntimeInfo } from "../src/sandbox/protocol";
import { resolveTrustedExecutable, RUNTIME_PROBE_PATH_DIRS } from "../src/sandbox/runtime-info";

const TOKEN = "test-sandbox-git-token-0123456789abcdef";
const HAS_BASH = existsSync("/bin/bash");
const LANDLOCK_WRAPPER = resolveLandlockWrapper();
const HAS_LANDLOCK = (() => {
  if (!LANDLOCK_WRAPPER) return false;
  const probe = spawnSync(LANDLOCK_WRAPPER, ["--abi"], { encoding: "utf8" });
  return probe.status === 0 && Number.parseInt(probe.stdout, 10) >= LANDLOCK_MIN_ABI;
})();
const HAS_GIT = resolveTrustedExecutable("git", RUNTIME_PROBE_PATH_DIRS) !== undefined;
const CAN_RUN_BASH = HAS_BASH && HAS_LANDLOCK && HAS_GIT;
const SKIP_REASON = !HAS_BASH
  ? "bash is not available on this platform"
  : !HAS_LANDLOCK
    ? "Landlock (ABI 3+) is not available on this platform"
    : "git is not available on this platform";

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
}

async function readEvents(response: Response): Promise<SandboxEvent[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as SandboxEvent);
}

function eventText(payload: unknown): string {
  const content = (payload as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

/** 初期化済みのサービスで bash を 1 回実行し、成功なら出力、失敗なら error 文言を返す */
async function runBash(
  service: ReturnType<typeof createSandboxService>,
  command: string,
  gitConfig: unknown = undefined,
): Promise<{ ok: boolean; text: string }> {
  const body: Record<string, unknown> = { params: { command } };
  if (gitConfig !== undefined) body.gitConfig = gitConfig;
  const response = await service.app.request("/v1/tools/bash/execute", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (response.status !== 200) assert.fail(`unexpected status ${response.status}: ${await response.text()}`);
  const events = await readEvents(response);
  const result = events.find((event) => event.type === "result");
  if (result) return { ok: true, text: eventText((result as { payload: unknown }).payload) };
  const error = events.find((event) => event.type === "error");
  assert.ok(error, `result も error も無い: ${JSON.stringify(events)}`);
  return { ok: false, text: (error as { message: string }).message };
}

/**
 * HOME は `/tmp` の外に作る。`/tmp` は Landlock の固定 write root なので、その下の HOME は
 * 仕様どおり「inside_workspace」として拒否される（テストの前提を本番の HOME 配置に合わせる）。
 */
function tmpHome(t: TestContext, prefix: string): string {
  const home = mkdtempSync(join(process.cwd(), `.${prefix}-`));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test("identity を 0600 の config へ書き、内容が同じなら書かない", async (t) => {
  const home = tmpHome(t, "pi-git-home-");
  const target = gitConfigTarget(home);
  assert.equal(target.path, join(home, ".config/u7agent", GIT_CONFIG_FILENAME));

  assert.deepEqual(
    await prepareGitConfig({ target, identity: { userName: 'a"b', userEmail: "a@example.com" }, forbiddenRoots: [] }),
    { ok: true },
  );
  const first = await lstat(target.path);
  assert.equal(first.mode & 0o777, 0o600);
  const text = await readFile(target.path, "utf8");
  assert.match(text, /name = "a\\"b"/);
  assert.match(text, /email = "a@example\.com"/);
  assert.match(text, /useConfigOnly = true/);

  // 内容が同じなら mtime を変えない（毎回 rename しない）
  assert.deepEqual(
    await prepareGitConfig({ target, identity: { userName: 'a"b', userEmail: "a@example.com" }, forbiddenRoots: [] }),
    { ok: true },
  );
  assert.equal((await lstat(target.path)).mtimeMs, first.mtimeMs);
});

test("親ディレクトリの symlink を拒否し、内容一致でも検査を skip しない", async (t) => {
  const home = tmpHome(t, "pi-git-symlink-home-");
  const target = gitConfigTarget(home);
  await prepareGitConfig({ target, identity: null, forbiddenRoots: [] });

  // 内容が同じでも、親を symlink に差し替えたら書かない（比較の前に lstat を通す）
  const moved = join(home, "moved-u7agent");
  await rename(target.dir, moved);
  await symlink(moved, target.dir);
  assert.deepEqual(await prepareGitConfig({ target, identity: null, forbiddenRoots: [] }), {
    ok: false,
    reason: "symlink",
  });

  // ファイル自体の symlink も拒否する
  const home2 = tmpHome(t, "pi-git-file-symlink-");
  const target2 = gitConfigTarget(home2);
  await mkdir(target2.dir, { recursive: true, mode: 0o700 });
  await symlink(join(home2, "outside"), target2.path);
  assert.deepEqual(await prepareGitConfig({ target: target2, identity: null, forbiddenRoots: [] }), {
    ok: false,
    reason: "symlink",
  });
});

test("HOME がワークスペースや許可 root の内側なら書かない", async (t) => {
  const home = tmpHome(t, "pi-git-inside-");
  const target = gitConfigTarget(home);
  assert.deepEqual(await prepareGitConfig({ target, identity: null, forbiddenRoots: [home] }), {
    ok: false,
    reason: "inside_workspace",
  });
  assert.deepEqual(
    await prepareGitConfig({ target, identity: null, forbiddenRoots: [join(home, ".config", "u7agent")] }),
    { ok: false, reason: "inside_workspace" },
  );
  assert.equal(existsSync(target.path), false);
});

test("runtime info は git-config-v1 と準備結果を返す", { skip: !CAN_RUN_BASH && SKIP_REASON }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-git-runtime-"));
  const home = tmpHome(t, "pi-git-runtime-home-");
  const service = createSandboxService({ token: TOKEN, rootCwd: root, homeDir: home });
  const response = await service.app.request("/v1/runtime/info", { headers: authHeaders() });
  assert.equal(response.status, 200);
  const info = (await response.json()) as SandboxRuntimeInfo;
  assert.deepEqual(info.capabilities, ["git-config-v1"]);
  assert.equal(info.gitConfig.state, "ready");
  assert.equal(info.gitConfig.path, join(home, ".config/u7agent", GIT_CONFIG_FILENAME));
});

test(
  "identity を設定すると git の global config になり、未設定は useConfigOnly で commit できない",
  { skip: !CAN_RUN_BASH && SKIP_REASON },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "pi-git-identity-"));
    const service = createSandboxService({
      token: TOKEN,
      rootCwd: root,
      homeDir: tmpHome(t, "pi-git-identity-home-"),
    });

    const configured = await runBash(service, "git config --global user.name; git config --global user.email", {
      userName: "u7chan",
      userEmail: "u7chan@example.com",
    });
    assert.equal(configured.ok, true, configured.text);
    assert.match(configured.text, /u7chan/);
    assert.match(configured.text, /u7chan@example\.com/);

    // 未設定 (null) は useConfigOnly だけ。自動推測で author を作らない
    const unset = await runBash(
      service,
      "git init -q .; git config --global --get user.useConfigOnly; LC_ALL=C git commit --allow-empty -m x 2>&1",
      null,
    );
    assert.equal(unset.ok, true, unset.text);
    assert.match(unset.text, /true/);
    assert.match(unset.text, /Author identity unknown/);

    // repo local の identity は local が優先され、commit できる
    const local = await runBash(
      service,
      [
        "git init -q .",
        "git -c user.name=x config user.email local@example.com",
        "git -c user.name=x config user.name local-user",
        "LC_ALL=C git commit --allow-empty -m ok 2>&1",
        'git log -1 --format="%an <%ae>"',
      ].join("; "),
      null,
    );
    assert.equal(local.ok, true, local.text);
    assert.match(local.text, /local-user/);
    assert.match(local.text, /local@example\.com/);
  },
);

test(
  "identity を設定しても global config はエージェントから書けない",
  { skip: !CAN_RUN_BASH && SKIP_REASON },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "pi-git-write-"));
    const home = tmpHome(t, "pi-git-write-home-");
    const service = createSandboxService({ token: TOKEN, rootCwd: root, homeDir: home });

    const write = await runBash(service, "git config --global user.name hacked; echo rc=$?", {
      userName: "u7chan",
      userEmail: "u7chan@example.com",
    });
    assert.equal(write.ok, true, write.text);
    assert.doesNotMatch(write.text, /rc=0/);
    assert.doesNotMatch(await readFile(join(home, ".config/u7agent", GIT_CONFIG_FILENAME), "utf8"), /hacked/);
  },
);

test("旧 BFF（gitConfig 無し）の bash では予約名を落とさない", { skip: !CAN_RUN_BASH && SKIP_REASON }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-git-env-"));
  const service = createSandboxService({ token: TOKEN, rootCwd: root, homeDir: tmpHome(t, "pi-git-env-home-") });
  const response = await service.app.request("/v1/tools/bash/execute", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      params: {
        command: 'echo "count=${GIT_CONFIG_COUNT:-unset} author=${GIT_AUTHOR_NAME:-unset}"',
      },
      env: { GIT_CONFIG_COUNT: "1", GIT_AUTHOR_NAME: "legacy" },
    }),
  });
  assert.equal(response.status, 200);
  const text = await readEvents(response)
    .then((events) => events.find((event) => event.type === "result"))
    .then((event) => eventText((event as { payload: unknown }).payload));
  assert.match(text, /count=1/);
  assert.match(text, /author=legacy/);
});

test(
  "gitConfig 付きの実行から GIT_SSH_COMMAND は残り、GIT_CONFIG_COUNT / GIT_AUTHOR_NAME は落ちる",
  { skip: !CAN_RUN_BASH && SKIP_REASON },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "pi-git-env2-"));
    const service = createSandboxService({ token: TOKEN, rootCwd: root, homeDir: tmpHome(t, "pi-git-env2-home-") });
    const response = await service.app.request("/v1/tools/bash/execute", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        params: {
          command:
            'echo "ssh=${GIT_SSH_COMMAND:-unset} count=${GIT_CONFIG_COUNT:-unset} author=${GIT_AUTHOR_NAME:-unset}"',
        },
        env: { GIT_SSH_COMMAND: "keep-me", GIT_CONFIG_COUNT: "1", GIT_AUTHOR_NAME: "legacy" },
        gitConfig: null,
      }),
    });
    assert.equal(response.status, 200);
    const text = await readEvents(response)
      .then((events) => events.find((event) => event.type === "result"))
      .then((event) => eventText((event as { payload: unknown }).payload));
    assert.match(text, /ssh=keep-me/);
    assert.match(text, /count=unset/);
    assert.match(text, /author=unset/);
  },
);

test("準備できない HOME では gitConfig 付きの bash だけを止める", { skip: !CAN_RUN_BASH && SKIP_REASON }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-git-fail-"));
  const home = tmpHome(t, "pi-git-fail-home-");
  const service = createSandboxService({ token: TOKEN, rootCwd: root, homeDir: home });
  // 起動時の準備を終わらせてから、親を symlink に差し替える
  await service.app.request("/v1/runtime/info", { headers: authHeaders() });
  const target = gitConfigTarget(home);
  await rename(target.dir, join(home, "moved"));
  symlinkSync(join(home, "moved"), target.dir);

  const blocked = await runBash(service, "echo should-not-run", {
    userName: "u7chan",
    userEmail: "u7chan@example.com",
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.text, /symlink/);

  // gitConfig 無し（旧 BFF）の bash は止めない
  const legacy = await runBash(service, "echo legacy-ok", undefined);
  assert.equal(legacy.ok, true, legacy.text);
  assert.match(legacy.text, /legacy-ok/);
});

test(
  "dubious ownership を cwd ごとに 1 回だけ検出し、runtime info に出す",
  { skip: !CAN_RUN_BASH && SKIP_REASON },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "pi-git-owner-"));
    const home = tmpHome(t, "pi-git-owner-home-");
    const calls = join(root, "calls.txt");
    const fakeGit = join(root, "fake-git");
    // 所有ユーザーを変えられない環境でも検出経路を固定できるよう、git の出力だけを差し替える
    await writeFile(
      fakeGit,
      `#!/bin/sh\nprintf 'call\\n' >> ${JSON.stringify(calls)}\nprintf "fatal: detected dubious ownership in repository at '%s'\\n" "$2" >&2\nexit 128\n`,
      { mode: 0o755 },
    );
    const service = createSandboxService({ token: TOKEN, rootCwd: root, homeDir: home, gitPath: fakeGit });

    const first = await runBash(service, "true", { userName: "u7chan", userEmail: "u7chan@example.com" });
    assert.equal(first.ok, true, first.text);
    const second = await runBash(service, "true", { userName: "u7chan", userEmail: "u7chan@example.com" });
    assert.equal(second.ok, true, second.text);

    const info = (await (
      await service.app.request("/v1/runtime/info", { headers: authHeaders() })
    ).json()) as SandboxRuntimeInfo;
    assert.deepEqual(info.gitConfig.ownershipWarnings, [{ cwd: "." }]);
    // cwd が同じ 2 回目は git を打たない
    assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 1);
  },
);
