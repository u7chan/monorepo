import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildChildEnv, extraChildEnvNames } from "../src/child-env";

const DUMMY_KEY_VAR = "DUMMY_PROVIDER_API_KEY";
const DUMMY_KEY = "sk-dummy-provider-0123456789abcdef";
const PROFILE_KEY_VAR = "DUMMY_PROFILE_API_KEY";
const PROFILE_KEY = "sk-from-profile-0123456789abcdef";

function bashPath(): string {
  if (existsSync("/bin/bash")) return "/bin/bash";
  if (existsSync("/usr/bin/bash")) return "/usr/bin/bash";
  return "";
}

const BASH = bashPath();
const SKIP_REASON = "bash is not available on this platform";

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runBash(env: NodeJS.ProcessEnv, script: string): Promise<RunResult> {
  return new Promise((resolveRun) => {
    // bash ツールと同じ起動方法 (stdio[0] = "ignore" → fd0 = /dev/null) を模倣
    // する。stdin を pipe にすると node はソケットペアを作り、bash は「stdin が
    // ソケット = rshd からの起動」と判定して BASH_ENV を読まなくなるため、
    // 起動設定の検証が意味を失う。
    const child = spawn(BASH, ["-c", script], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", () => resolveRun({ stdout, stderr, code: -1 }));
    child.on("close", (code) => resolveRun({ stdout, stderr, code }));
  });
}

function baseEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    [DUMMY_KEY_VAR]: DUMMY_KEY,
    [PROFILE_KEY_VAR]: "unused",
  };
}

test("buildChildEnv copies only allowlisted variables into a fresh object", () => {
  const base: NodeJS.ProcessEnv = {
    ...baseEnv(),
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp/home",
    LANG: "ja_JP.UTF-8",
    TMPDIR: "/tmp",
    TZ: "Asia/Tokyo",
    BASH_ENV: "/tmp/profile",
    ENV: "/tmp/profile",
    NODE_OPTIONS: "--max-old-space-size=64",
    PI_SESSION_ID: "pi-session",
    PI_SESSION_FILE: "/tmp/session.jsonl",
    PI_PROVIDER: "stub",
    PI_MODEL: "stub-model",
    PI_REASONING_LEVEL: "low",
    // BFF 自身が読む設定変数。子プロセスへは不要なので継承しない。
    PI_MODEL_APP_SETTING: "should-not-inherit",
  };
  const childEnv = buildChildEnv(base);

  // 必要な変数は維持される
  assert.equal(childEnv.PATH, "/usr/local/bin:/usr/bin:/bin");
  assert.equal(childEnv.HOME, "/tmp/home");
  assert.equal(childEnv.LANG, "ja_JP.UTF-8");
  assert.equal(childEnv.TMPDIR, "/tmp");
  assert.equal(childEnv.TZ, "Asia/Tokyo");
  // SDK が注入するセッションメタ変数は維持される
  assert.equal(childEnv.PI_SESSION_ID, "pi-session");
  assert.equal(childEnv.PI_SESSION_FILE, "/tmp/session.jsonl");
  assert.equal(childEnv.PI_PROVIDER, "stub");
  assert.equal(childEnv.PI_MODEL, "stub-model");
  assert.equal(childEnv.PI_REASONING_LEVEL, "low");
  // キーも実行へ介入する変数も継承されない
  assert.equal(childEnv[DUMMY_KEY_VAR], undefined);
  assert.equal(childEnv.BASH_ENV, undefined);
  assert.equal(childEnv.ENV, undefined);
  assert.equal(childEnv.NODE_OPTIONS, undefined);
  assert.equal(childEnv.PI_MODEL_APP_SETTING, undefined);
  // 元のオブジェクトは変更されない
  assert.equal(base.PATH, "/usr/local/bin:/usr/bin:/bin");
  assert.equal(base[DUMMY_KEY_VAR], DUMMY_KEY);
});

test("buildChildEnv accepts extra variable names without allowing PI_ overrides", () => {
  const base: NodeJS.ProcessEnv = {
    HTTP_PROXY: "http://proxy.local:3128",
    PI_SESSION_ID: "pi-session",
    PI_EXTRA: "nope",
    SOMETHING: "x",
  };
  const childEnv = buildChildEnv(base, ["HTTP_PROXY"]);
  assert.equal(childEnv.HTTP_PROXY, "http://proxy.local:3128");
  assert.equal(childEnv.SOMETHING, undefined);
  assert.equal(childEnv.PI_EXTRA, undefined);
});

test("extraChildEnvNames parses PI_CHILD_ENV_EXTRA and drops invalid names", () => {
  // POSIX 風の変数名だけを許す (数字始まり・ハイフン入り・PI_* は不可)
  assert.deepEqual(extraChildEnvNames({ PI_CHILD_ENV_EXTRA: " HTTP_PROXY , 9bad,no-proxy,PI_SESSION_ID " }), [
    "HTTP_PROXY",
  ]);
  assert.deepEqual(extraChildEnvNames({}), []);
  assert.deepEqual(extraChildEnvNames({ PI_CHILD_ENV_EXTRA: "  " }), []);
});

test("concurrent builds are independent and never touch process.env", () => {
  const snapshot = { ...process.env };
  const base = { ...process.env, [DUMMY_KEY_VAR]: DUMMY_KEY };
  const first = buildChildEnv(base);
  const second = buildChildEnv(base);
  first.PATH = "tampered";
  assert.notEqual(second.PATH, "tampered");
  assert.equal(process.env[DUMMY_KEY_VAR], undefined, "test process must not gain keys");
  assert.deepEqual({ ...process.env }, snapshot);
});

test("child process environment itself has no keys (env / printenv / Node.js)", { skip: !BASH && SKIP_REASON }, async () => {
  const childEnv = buildChildEnv(baseEnv());
  const result = await runBash(
    childEnv,
    `
echo "PATH=$PATH"
if printenv ${DUMMY_KEY_VAR} >/dev/null 2>&1; then echo "LEAK_PRINTENV"; fi
node -e 'process.exit(process.env.${DUMMY_KEY_VAR} ? 42 : 0)' || echo "LEAK_NODE"
printenv | grep -c . >/dev/null
`,
  );
  assert.equal(result.code, 0, `script failed: ${result.stderr}`);
  assert.ok(!result.stdout.includes(DUMMY_KEY), "raw key must not appear in child output");
  assert.ok(!result.stdout.includes("LEAK_PRINTENV"));
  assert.ok(!result.stdout.includes("LEAK_NODE"));
  assert.ok(result.stdout.includes("PATH="), "PATH must be present for normal commands");
});

test("startup settings cannot re-inject keys because BASH_ENV is not inherited", { skip: !BASH && SKIP_REASON }, async () => {
  // 非対話の bash は BASH_ENV があれば読む。許可リストがこれを落とすことで
  // プロファイル経由の再投入が起きないことを、対照実験とともに確認する。
  const dir = mkdtempSync(join(tmpdir(), "pi-child-env-"));
  const profile = join(dir, "profile.sh");
  writeFileSync(profile, `export ${PROFILE_KEY_VAR}=${PROFILE_KEY}\n`, "utf8");

  const withInjection = { ...baseEnv(), BASH_ENV: profile };
  const control = await runBash(withInjection, `printenv ${PROFILE_KEY_VAR}`);
  assert.equal(control.stdout.trim(), PROFILE_KEY, "control: BASH_ENV would inject the key");

  const guarded = await runBash(
    buildChildEnv(withInjection),
    `
if printenv ${PROFILE_KEY_VAR} >/dev/null 2>&1; then echo "REINJECTED"; fi
if printenv BASH_ENV >/dev/null 2>&1; then echo "BASH_ENV_PRESENT"; fi
`,
  );
  assert.equal(guarded.code, 0);
  assert.ok(!guarded.stdout.includes("REINJECTED"));
  assert.ok(!guarded.stdout.includes("BASH_ENV_PRESENT"));
  assert.ok(!guarded.stdout.includes(PROFILE_KEY));
});

test("normal commands work in the restricted environment", { skip: !BASH && SKIP_REASON }, async () => {
  const result = await runBash(
    buildChildEnv(baseEnv()),
    `
mktemp >/dev/null || exit 10
command -v ls >/dev/null || exit 11
ls / >/dev/null || exit 12
echo "$(date +%Y)" >/dev/null || exit 13
echo OK
`,
  );
  assert.equal(result.code, 0, `script failed: ${result.stderr}`);
  assert.ok(result.stdout.includes("OK"));
});
