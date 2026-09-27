// 設定 → ランタイムの表示変換と、health / 実行環境をまとめて取り直す手順を検証する。
// 状態コード 6 種・空一覧・部分失敗・refreshHealth の null 失敗扱い・古い応答の排除・ゲート・
// 一括コピー本文の整形を固定する。モデルカタログは設定 → モデルへ移設したため、ここでは取得しない。

import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeReloadGate,
  HEALTH_RELOAD_FAILED_MESSAGE,
  reloadRuntime,
  runtimeCommandRows,
  runtimeDiagnosticText,
  runtimeEnvironmentSummary,
  runtimeFetchStateOf,
} from "../src/lib/runtimeEnvironment";
import type { Health, RuntimeEnvironmentResponse, RuntimeEnvironmentState } from "../src/types";

const STATES: RuntimeEnvironmentState[] = [
  "connected",
  "not_configured",
  "unreachable",
  "unauthorized",
  "timeout",
  "probe_failed",
];

const HEALTH: Health = { ready: true, sandboxConfigured: true };
/** 単発の取得 (再試行なし) を表す判定。親の health をそのまま適用してよいケース */
const alwaysCurrent = () => true;
const CONNECTED: RuntimeEnvironmentResponse = {
  state: "connected",
  environment: {
    os: "Debian GNU/Linux 13 (trixie)",
    arch: "x86_64",
    user: "node",
    isRoot: false,
    workspace: "/workspace",
  },
  commands: [{ name: "curl", version: "8.14.1" }],
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("every state code has its own label, detail and tone", () => {
  const summaries = STATES.map((state) => [state, runtimeEnvironmentSummary(state)] as const);
  assert.equal(summaries.length, 6);
  for (const [state, summary] of summaries) {
    assert.ok(summary.label.length > 0, `${state} のラベル`);
    assert.ok(summary.detail.length > 0, `${state} の説明`);
  }
  assert.equal(runtimeEnvironmentSummary("connected").tone, "ok");
  assert.equal(runtimeEnvironmentSummary("probe_failed").tone, "danger");
  assert.equal(runtimeEnvironmentSummary("not_configured").tone, "muted");
  // 生のエラー文言や URL を表示文言に混ぜない
  for (const [, summary] of summaries) {
    assert.equal(/http:|token=|at \//.test(summary.detail), false);
  }
});

test("command rows keep the detected order and mark missing versions", () => {
  assert.deepEqual(runtimeCommandRows([]), []);
  assert.deepEqual(
    runtimeCommandRows([
      { name: "curl", version: "8.14.1" },
      { name: "npm", version: null },
    ]),
    [
      { key: "0-curl", name: "curl", version: "8.14.1" },
      { key: "1-npm", name: "npm", version: "バージョン不明" },
    ],
  );
  // 同名が来ても key が衝突しない
  assert.deepEqual(
    runtimeCommandRows([
      { name: "curl", version: null },
      { name: "curl", version: null },
    ]).map((row) => row.key),
    ["0-curl", "1-curl"],
  );
});

test("reloads health and the environment and waits for them to settle", async () => {
  const environment = deferred<RuntimeEnvironmentResponse>();
  const healthCalls: number[] = [];
  const pending = reloadRuntime({
    includeHealth: true,
    isCurrent: alwaysCurrent,
    refreshHealth: async () => {
      healthCalls.push(1);
      return HEALTH;
    },
    getEnvironment: () => environment.promise,
  });
  environment.resolve(CONNECTED);
  const results = await pending;
  assert.equal(healthCalls.length, 1);
  assert.deepEqual(results.health, { ok: true, value: HEALTH });
  assert.deepEqual(results.environment, { ok: true, value: CONNECTED });
});

test("treats a null health result as a failure and keeps the environment result", async () => {
  const results = await reloadRuntime({
    includeHealth: true,
    isCurrent: alwaysCurrent,
    refreshHealth: async () => null,
    getEnvironment: async () => CONNECTED,
  });
  assert.deepEqual(results.health, { ok: false, message: HEALTH_RELOAD_FAILED_MESSAGE });
  assert.equal(results.environment.ok, true);
});

test("keeps a successful health result when the environment fails", async () => {
  const results = await reloadRuntime({
    includeHealth: true,
    isCurrent: alwaysCurrent,
    refreshHealth: async () => HEALTH,
    getEnvironment: async () => {
      throw new Error("実行環境を取得できませんでした");
    },
  });
  assert.deepEqual(results.health, { ok: true, value: HEALTH });
  assert.deepEqual(results.environment, { ok: false, message: "実行環境を取得できませんでした" });
});

test("opening the page fetches only the environment", async () => {
  let healthCalls = 0;
  const results = await reloadRuntime({
    includeHealth: false,
    isCurrent: alwaysCurrent,
    refreshHealth: async () => {
      healthCalls += 1;
      return HEALTH;
    },
    getEnvironment: async () => CONNECTED,
  });
  assert.equal(healthCalls, 0, "親が持つ health を再取得しない");
  assert.equal(results.health, null);
  assert.equal(results.environment.ok, true);
});

test("converts reload outcomes into fetch states without losing the previous value on success", () => {
  assert.deepEqual(runtimeFetchStateOf({ ok: true, value: CONNECTED }), { status: "ready", value: CONNECTED });
  assert.deepEqual(runtimeFetchStateOf<RuntimeEnvironmentResponse>({ ok: false, message: "失敗" }), {
    status: "error",
    message: "失敗",
  });
});

test("applies only the latest reload attempt", () => {
  const gate = createRuntimeReloadGate();
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(first(), false);
  assert.equal(second(), true);
  gate.invalidate();
  assert.equal(second(), false, "アンマウント後の応答は適用しない");
  const third = gate.begin();
  assert.equal(third(), true);
});

/**
 * 親 (useRuntimeCatalog.refreshHealth) と同じく、isCurrent が false なら親へ適用せず null を返す。
 * 画面の世代ゲートを親へ渡さないと、遅れて返った古い health が親の state を上書きする。
 */
function parentRefreshHealth(values: Array<Promise<Health>>, applied: string[]) {
  let calls = 0;
  return async (isCurrent?: () => boolean): Promise<Health | null> => {
    const value = await values[calls++]!;
    if (isCurrent && !isCurrent()) return null;
    applied.push(value.model ?? "");
    return value;
  };
}

function reloadWithHealth(
  isCurrent: () => boolean,
  refreshHealth: (isCurrent?: () => boolean) => Promise<Health | null>,
) {
  return reloadRuntime({
    includeHealth: true,
    isCurrent,
    refreshHealth,
    getEnvironment: async () => CONNECTED,
  });
}

test("does not apply a stale health response to the parent after a newer reload", async () => {
  const gate = createRuntimeReloadGate();
  const applied: string[] = [];
  const stale = deferred<Health>();
  const fresh = deferred<Health>();
  const refreshHealth = parentRefreshHealth([stale.promise, fresh.promise], applied);

  const staleReload = reloadWithHealth(gate.begin(), refreshHealth);
  const freshReload = reloadWithHealth(gate.begin(), refreshHealth);
  // 新しい取得が先に返り、古い取得が後から返る順序を再現する
  fresh.resolve({ ...HEALTH, model: "new/model" });
  const freshResult = await freshReload;
  stale.resolve({ ...HEALTH, model: "stale/model" });
  const staleResult = await staleReload;

  assert.deepEqual(applied, ["new/model"], "古い応答は親の health へ適用しない");
  assert.deepEqual(freshResult.health, { ok: true, value: { ...HEALTH, model: "new/model" } });
  assert.deepEqual(staleResult.health, { ok: false, message: HEALTH_RELOAD_FAILED_MESSAGE });
});

test("does not apply health to the parent after the page unmounts", async () => {
  const gate = createRuntimeReloadGate();
  const applied: string[] = [];
  const health = deferred<Health>();
  const reload = reloadWithHealth(gate.begin(), parentRefreshHealth([health.promise], applied));
  gate.invalidate();
  health.resolve({ ...HEALTH, model: "late/model" });
  const result = await reload;

  assert.deepEqual(applied, [], "アンマウント後の応答は親の health へ適用しない");
  assert.deepEqual(result.health, { ok: false, message: HEALTH_RELOAD_FAILED_MESSAGE });
});

const HEALTH_FULL: Health = {
  ready: true,
  cwd: "/workspace",
  model: "openai/gpt-6-luna",
  sandboxConfigured: true,
  versions: { piCodingAgent: "0.87.1", piAi: "0.87.1", commitHash: "673d6e4" },
  sessionStore: { ok: true, path: "/session-store" },
  appDb: { ok: true, path: "/session-store/u7agent.db" },
};

test("一括コピー本文は画面と同じ見出し・値・注記を markdown で出す", () => {
  const text = runtimeDiagnosticText({
    health: HEALTH_FULL,
    healthFailed: false,
    environment: { status: "ready", value: CONNECTED },
  });

  assert.equal(
    text,
    [
      "# u7agent ランタイム診断",
      "",
      "## 接続状態",
      "- ランタイム: 利用可能",
      "- サンドボックス: 設定済み",
      "- 既定モデル: openai/gpt-6-luna（アプリの既定モデルです。会話中に使われている実効モデルではありません。）",
      "- 作業ディレクトリ (cwd): /workspace",
      "- セッションストア: 利用可能 · /session-store",
      "- アプリ DB: 利用可能 · /session-store/u7agent.db",
      "- pi-coding-agent: 0.87.1",
      "- pi-ai: 0.87.1",
      "- COMMIT_HASH: 673d6e4",
      "",
      "## 実行環境（サンドボックス側）",
      "- 接続状態: 接続中",
      "- OS: Debian GNU/Linux 13 (trixie)",
      "- アーキテクチャ: x86_64",
      "- 実行ユーザー: node（非 root）",
      "- ワークスペース: /workspace",
      "",
      "## 利用可能なコマンド",
      "- curl: 8.14.1",
      "実際に検出できたコマンドだけを表示します。",
    ].join("\n"),
  );
});

test("health が無くても行を残し、前回値の断り書きを見出しの直後に出す", () => {
  const text = runtimeDiagnosticText({ health: null, healthFailed: true, environment: { status: "loading" } });

  assert.ok(text.includes("## 接続状態\n" + HEALTH_RELOAD_FAILED_MESSAGE), "見出しの直後に断り書きを出す");
  assert.ok(text.includes("- ランタイム: 情報なし"));
  assert.ok(text.includes("- サンドボックス: 情報なし"));
  assert.ok(text.includes("- 既定モデル: 指定なし"));
  assert.ok(text.includes("- 作業ディレクトリ (cwd): 情報なし"));
  assert.ok(text.includes("- セッションストア: 情報なし"));
  assert.ok(text.includes("- アプリ DB: 情報なし"));
  assert.ok(text.includes("- pi-coding-agent: 情報なし"));
  assert.ok(!text.includes("- pi-ai:"), "値が無いバージョン行は出さない");
  assert.ok(!text.includes("- COMMIT_HASH:"), "値が無いバージョン行は出さない");
});

test("取得できていないセクションは状態文言を出し、黙って省かない", () => {
  const loading = runtimeDiagnosticText({ health: HEALTH, healthFailed: false, environment: { status: "loading" } });
  assert.ok(loading.includes("実行環境を取得しています。"));
  assert.ok(loading.includes("コマンドを検出しています。"));

  const failed = runtimeDiagnosticText({
    health: HEALTH,
    healthFailed: false,
    environment: { status: "error", message: "サンドボックスの診断が期限内に応答しませんでした。" },
  });
  assert.ok(failed.includes("実行環境を取得できませんでした。サンドボックスの診断が期限内に応答しませんでした。"));
  assert.ok(failed.includes("実行環境の情報を取得できていないため、コマンドは表示していません。"));

  const multiline = runtimeDiagnosticText({
    health: HEALTH,
    healthFailed: false,
    environment: { status: "error", message: "1 行目\n2 行目" },
  });
  assert.ok(multiline.includes("実行環境を取得できませんでした。1 行目 2 行目"), "エラー文言の改行も畳む");
});

test("未接続の状態は理由を注記として出し、環境とコマンドは非表示にする", () => {
  for (const state of STATES) {
    if (state === "connected") continue;
    const summary = runtimeEnvironmentSummary(state);
    const text = runtimeDiagnosticText({
      health: HEALTH,
      healthFailed: false,
      environment: { status: "ready", value: { state } },
    });

    assert.ok(text.includes(`- 接続状態: ${summary.label}（${summary.detail}）`), state);
    assert.ok(!text.includes("- OS:"), `${state} では環境の値を出さない`);
    assert.ok(text.includes("実行環境の情報を取得できていないため、コマンドは表示していません。"), state);
  }
});

test("root 実行とコマンドなしとバージョン不明をそのままコピーに残す", () => {
  const text = runtimeDiagnosticText({
    health: HEALTH,
    healthFailed: false,
    environment: {
      status: "ready",
      value: {
        state: "connected",
        environment: { os: "Debian", arch: "aarch64", user: "root", isRoot: true, workspace: "/workspace" },
        commands: [{ name: "xz", version: null }],
      },
    },
  });

  assert.ok(text.includes("- 実行ユーザー: root（root）"));
  assert.ok(text.includes("（root で動いています。コンテナ外への影響を避けるため、非 root 実行を推奨します。）"));
  assert.ok(text.includes("- xz: バージョン不明"));

  const empty = runtimeDiagnosticText({
    health: HEALTH,
    healthFailed: false,
    environment: { status: "ready", value: { state: "connected", environment: CONNECTED.environment, commands: [] } },
  });
  assert.ok(empty.includes("検出できたコマンドはありません。"));
  assert.ok(!empty.includes("実際に検出できたコマンドだけを表示します。"), "行が無いときは注記も出さない");
});

test("値の改行は空白へ畳み、コピー本文の行構造を壊さない", () => {
  const text = runtimeDiagnosticText({
    health: { ...HEALTH, cwd: "/work\nspace" },
    healthFailed: false,
    environment: {
      status: "ready",
      value: {
        state: "connected",
        environment: { os: "Debian", arch: "x86_64", user: "node", isRoot: false, workspace: "/w" },
        commands: [{ name: "bash", version: "5.2.37\n(extra)" }],
      },
    },
  });

  assert.ok(text.includes("- 作業ディレクトリ (cwd): /work space"));
  assert.ok(text.includes("- bash: 5.2.37 (extra)"));
});
