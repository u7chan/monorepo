// 設定 → ランタイムの表示変換と、health / 利用中のモデル / 実行環境をまとめて取り直す手順を検証する。
// 状態コード 6 種・空一覧・部分失敗・refreshHealth の null 失敗扱い・古い応答の排除・ゲート・
// 行ビルダー（既定モデルの分類・コピー対象・ボイスの空文字）・一括コピー本文の整形を固定する。
// モデルカタログは設定 → モデルへ移設したため、ここでは取得しない。

import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeReloadGate,
  HEALTH_RELOAD_FAILED_MESSAGE,
  reloadRuntime,
  RUNTIME_INTEGRATIONS_UNAVAILABLE,
  RUNTIME_INTEGRATIONS_LOADING,
  RUNTIME_MODELS_ERROR_LEAD,
  RUNTIME_MODELS_LOADING,
  runtimeCommandRows,
  runtimeConnectionRows,
  runtimeContentState,
  runtimeDiagnosticText,
  runtimeEnvironmentSummary,
  runtimeFetchStateOf,
  runtimeIntegrationRows,
  runtimeModelRows,
} from "../src/lib/runtimeEnvironment";
import type { Health, RuntimeEnvironmentResponse, RuntimeEnvironmentState, RuntimeInUseResponse } from "../src/types";

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
  landlock: { state: "enabled", abi: 6, minAbi: 3 },
};
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const IN_USE: RuntimeInUseResponse = {
  title: {
    enabled: true,
    model: "openai/gpt-6-luna",
    thinkingLevel: "low",
    effectiveThinkingLevel: "high",
    modelAvailable: true,
  },
  content: {
    configured: true,
    enabled: true,
    keyAvailable: true,
    imageModel: "openai/gpt-image-2",
    speechModel: "google/gemini-3.8-flash-tts",
    speechVoice: "Kore",
    bgmModel: "google/lyria-3-clip-preview",
  },
  webSearch: { enabled: true, provider: "tavily", host: "api.tavily.com" },
  cloudflare: { configured: true, available: true, accountId: ACCOUNT_ID },
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

test("reloads health, in-use models and the environment and waits for them to settle", async () => {
  const environment = deferred<RuntimeEnvironmentResponse>();
  const healthCalls: number[] = [];
  const pending = reloadRuntime({
    includeHealth: true,
    isCurrent: alwaysCurrent,
    refreshHealth: async () => {
      healthCalls.push(1);
      return HEALTH;
    },
    getInUse: async () => IN_USE,
    getEnvironment: () => environment.promise,
  });
  environment.resolve(CONNECTED);
  const results = await pending;
  assert.equal(healthCalls.length, 1);
  assert.deepEqual(results.health, { ok: true, value: HEALTH });
  assert.deepEqual(results.inUse, { ok: true, value: IN_USE });
  assert.deepEqual(results.environment, { ok: true, value: CONNECTED });
});

test("treats a null health result as a failure and keeps the other results", async () => {
  const results = await reloadRuntime({
    includeHealth: true,
    isCurrent: alwaysCurrent,
    refreshHealth: async () => null,
    getInUse: async () => IN_USE,
    getEnvironment: async () => CONNECTED,
  });
  assert.deepEqual(results.health, { ok: false, message: HEALTH_RELOAD_FAILED_MESSAGE });
  assert.equal(results.inUse.ok, true);
  assert.equal(results.environment.ok, true);
});

test("keeps the in-use models when the environment fails and the reverse", async () => {
  const environmentFailed = await reloadRuntime({
    includeHealth: true,
    isCurrent: alwaysCurrent,
    refreshHealth: async () => HEALTH,
    getInUse: async () => IN_USE,
    getEnvironment: async () => {
      throw new Error("実行環境を取得できませんでした");
    },
  });
  assert.deepEqual(environmentFailed.health, { ok: true, value: HEALTH });
  assert.deepEqual(environmentFailed.inUse, { ok: true, value: IN_USE });
  assert.deepEqual(environmentFailed.environment, { ok: false, message: "実行環境を取得できませんでした" });

  const inUseFailed = await reloadRuntime({
    includeHealth: true,
    isCurrent: alwaysCurrent,
    refreshHealth: async () => HEALTH,
    getInUse: async () => {
      throw new Error("利用中のモデルを取得できませんでした");
    },
    getEnvironment: async () => CONNECTED,
  });
  assert.deepEqual(inUseFailed.inUse, { ok: false, message: "利用中のモデルを取得できませんでした" });
  assert.equal(inUseFailed.environment.ok, true, "in-use の失敗で実行環境を捨てない");
});

test("opening the page fetches in-use models and the environment but not health", async () => {
  let healthCalls = 0;
  const results = await reloadRuntime({
    includeHealth: false,
    isCurrent: alwaysCurrent,
    refreshHealth: async () => {
      healthCalls += 1;
      return HEALTH;
    },
    getInUse: async () => IN_USE,
    getEnvironment: async () => CONNECTED,
  });
  assert.equal(healthCalls, 0, "親が持つ health を再取得しない");
  assert.equal(results.health, null);
  assert.equal(results.inUse.ok, true);
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
    getInUse: async () => IN_USE,
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

function rowOf(rows: ReturnType<typeof runtimeModelRows>, label: string) {
  const row = rows.find((candidate) => candidate.label === label);
  assert.ok(row, `行「${label}」がある`);
  return row;
}

test("既定モデルは接続状態から外し、利用中のモデルの先頭に出す", () => {
  assert.equal(
    runtimeConnectionRows(HEALTH_FULL).some((row) => row.label === "既定モデル"),
    false,
    "接続状態に既定モデルを残さない",
  );
  assert.equal(runtimeModelRows(HEALTH_FULL, IN_USE)[0]?.label, "既定モデル");
});

test("既定モデルは health.model の有無だけで未設定と断定しない", () => {
  // health 未取得
  assert.deepEqual(runtimeModelRows(null, null)[0], { label: "既定モデル", value: "情報なし" });
  // 値あり: 実効モデルではない注記とコピー対象を持つ
  assert.deepEqual(runtimeModelRows({ ...HEALTH, model: "openai/gpt-6-luna" }, IN_USE)[0], {
    label: "既定モデル",
    value: "openai/gpt-6-luna",
    note: "アプリの既定モデルです。会話中に使われている実効モデルではありません。",
    copy: { text: "openai/gpt-6-luna", label: "既定モデルのIDをコピー" },
  });
  // 保存値が無い
  assert.deepEqual(runtimeModelRows({ ...HEALTH, defaultModelUnset: true }, IN_USE)[0], {
    label: "既定モデル",
    value: "未設定",
  });
  // 保存値が利用不能: 理由を注記に出し、値が無いのでコピーしない
  assert.deepEqual(runtimeModelRows({ ...HEALTH, defaultModelError: "許可リスト外です" }, IN_USE)[0], {
    label: "既定モデル",
    value: "利用できません",
    note: "許可リスト外です",
  });
  // 候補なし・ランタイム不可
  assert.deepEqual(runtimeModelRows({ ...HEALTH, availabilityError: "利用できるモデルがありません" }, IN_USE)[0], {
    label: "既定モデル",
    value: "利用できません",
    note: "利用できるモデルがありません",
  });
  // どれにも当たらない
  assert.deepEqual(runtimeModelRows(HEALTH, IN_USE)[0], { label: "既定モデル", value: "情報なし" });
});

test("会話タイトルは状態を注記に出し、Effort は実効値だけを出す", () => {
  const enabled = rowOf(runtimeModelRows(HEALTH_FULL, IN_USE), "会話タイトル");
  assert.equal(enabled.value, "openai/gpt-6-luna");
  assert.ok(enabled.note?.startsWith("有効"));
  assert.ok(enabled.note?.includes("Effort: high"));
  assert.equal(enabled.note?.includes("Effort: low"), false, "保存値 thinkingLevel を利用中として出さない");
  assert.deepEqual(enabled.copy, { text: "openai/gpt-6-luna", label: "会話タイトルのモデルIDをコピー" });

  // 無効でも保存済みのモデルは残す
  const disabled = rowOf(
    runtimeModelRows(HEALTH_FULL, {
      ...IN_USE,
      title: { ...IN_USE.title, enabled: false, thinkingLevel: null, effectiveThinkingLevel: null },
    }),
    "会話タイトル",
  );
  assert.equal(disabled.value, "openai/gpt-6-luna");
  assert.ok(disabled.note?.startsWith("無効"));
  assert.ok(disabled.note?.includes("保存済みのモデルは残ります"));
  assert.equal(disabled.note?.includes("Effort"), false, "実効値が無いときは Effort を出さない");

  const unselected = rowOf(
    runtimeModelRows(HEALTH_FULL, {
      ...IN_USE,
      title: { ...IN_USE.title, model: null, effectiveThinkingLevel: null },
    }),
    "会話タイトル",
  );
  assert.deepEqual(unselected, { label: "会話タイトル", value: "未選択" });

  const unavailable = rowOf(
    runtimeModelRows(HEALTH_FULL, { ...IN_USE, title: { ...IN_USE.title, modelAvailable: false } }),
    "会話タイトル",
  );
  assert.equal(unavailable.value, "openai/gpt-6-luna");
  assert.ok(unavailable.note?.startsWith("候補外"));
});

test("コンテンツ生成はグループ単位で 1 つの状態を出し、ボイスだけ注記でコピーできる", () => {
  // ゲートの順序: 未設定 → 停止中 → キー未復号 → 有効
  assert.equal(
    runtimeContentState({ ...IN_USE.content, configured: false, enabled: false, keyAvailable: false }),
    "未設定",
  );
  assert.equal(runtimeContentState({ ...IN_USE.content, enabled: false, keyAvailable: false }), "停止中");
  assert.equal(runtimeContentState({ ...IN_USE.content, keyAvailable: false }), "キー未復号");
  assert.equal(runtimeContentState(IN_USE.content), "有効");

  const rows = runtimeModelRows(HEALTH_FULL, IN_USE);
  assert.deepEqual(rowOf(rows, "コンテンツ生成"), { label: "コンテンツ生成", value: "有効" });
  // 行ごとに同じチップを並べない
  for (const label of ["画像生成モデル", "音声モデル", "BGM モデル"]) {
    assert.equal(rowOf(rows, label).note?.includes("有効") ?? false, false, `${label} に状態を繰り返さない`);
  }

  assert.deepEqual(rowOf(rows, "画像生成モデル"), {
    label: "画像生成モデル",
    value: "openai/gpt-image-2",
    copy: { text: "openai/gpt-image-2", label: "画像生成モデルのIDをコピー" },
  });
  const speech = rowOf(rows, "音声モデル");
  assert.deepEqual(speech.copy, {
    text: "google/gemini-3.8-flash-tts",
    label: "音声モデルのIDをコピー",
  });
  assert.equal(speech.note, "ボイス: Kore");
  assert.deepEqual(speech.noteCopy, { text: "Kore", label: "音声のボイスをコピー" });

  // ボイスの空文字は API が null へ正規化する。指定なしを値にしたり、コピーさせたりしない
  const noVoice = rowOf(
    runtimeModelRows(HEALTH_FULL, { ...IN_USE, content: { ...IN_USE.content, speechVoice: null } }),
    "音声モデル",
  );
  assert.equal(noVoice.note, "ボイス: 指定なし");
  assert.equal(noVoice.noteCopy, undefined);

  // 未設定のときも行は残す
  const unsetContent = runtimeModelRows(HEALTH_FULL, {
    ...IN_USE,
    content: {
      configured: false,
      enabled: true,
      keyAvailable: false,
      imageModel: null,
      speechModel: null,
      speechVoice: null,
      bgmModel: null,
    },
  });
  assert.deepEqual(rowOf(unsetContent, "コンテンツ生成"), {
    label: "コンテンツ生成",
    value: "未設定",
    note: "コンテンツ生成の設定がありません。",
  });
  assert.deepEqual(rowOf(unsetContent, "音声モデル"), { label: "音声モデル", value: "未設定" });
});

test("外部連携は Web 検索の provider と host、Cloudflare のアカウントIDを出す", () => {
  const rows = runtimeIntegrationRows(IN_USE);
  assert.deepEqual(rows, [
    {
      label: "Web 検索",
      value: "tavily",
      note: "api.tavily.com · 有効",
      copy: { text: "tavily", label: "Web 検索の provider ID をコピー" },
    },
    {
      label: "Cloudflare",
      value: ACCOUNT_ID,
      note: "設定済み",
      copy: { text: ACCOUNT_ID, label: "Cloudflare のアカウントIDをコピー" },
    },
  ]);

  const stopped = runtimeIntegrationRows({
    ...IN_USE,
    webSearch: { enabled: false, provider: "exa", host: "exa.ai" },
  });
  assert.equal(stopped[0]?.note, "exa.ai · 停止中");

  const unsetCloudflare = runtimeIntegrationRows({
    ...IN_USE,
    cloudflare: { configured: false, available: true, accountId: null },
  });
  assert.deepEqual(unsetCloudflare[1], { label: "Cloudflare", value: "未設定" });

  const unavailableCloudflare = runtimeIntegrationRows({
    ...IN_USE,
    cloudflare: { configured: true, available: false, accountId: ACCOUNT_ID },
  });
  assert.equal(unavailableCloudflare[1]?.value, ACCOUNT_ID);
  assert.ok(unavailableCloudflare[1]?.note?.startsWith("利用できません"));
});

test("一括コピー本文は画面と同じ見出し・値・注記を markdown で出す", () => {
  const text = runtimeDiagnosticText({
    health: HEALTH_FULL,
    healthFailed: false,
    inUse: { status: "ready", value: IN_USE },
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
      "- 作業ディレクトリ (cwd): /workspace",
      "- セッションストア: 利用可能 · /session-store",
      "- アプリ DB: 利用可能 · /session-store/u7agent.db",
      "- pi-coding-agent: 0.87.1",
      "- pi-ai: 0.87.1",
      "- COMMIT_HASH: 673d6e4",
      "",
      "## 利用中のモデル",
      "- 既定モデル: openai/gpt-6-luna（アプリの既定モデルです。会話中に使われている実効モデルではありません。）",
      "- 会話タイトル: openai/gpt-6-luna（有効 · Effort: high）",
      "- コンテンツ生成: 有効",
      "- 画像生成モデル: openai/gpt-image-2",
      "- 音声モデル: google/gemini-3.8-flash-tts（ボイス: Kore）",
      "- BGM モデル: google/lyria-3-clip-preview",
      "",
      "## 外部連携",
      "- Web 検索: tavily（api.tavily.com · 有効）",
      `- Cloudflare: ${ACCOUNT_ID}（設定済み）`,
      "",
      "## 実行環境（サンドボックス側）",
      "- 接続状態: 接続中",
      "- OS: Debian GNU/Linux 13 (trixie)",
      "- アーキテクチャ: x86_64",
      "- 実行ユーザー: node（非 root）",
      "- ワークスペース: /workspace",
      "- Landlock: 有効（ABI 6）（bash の作成・書き込み・削除は許可 root の外で EACCES になります。）",
      "",
      "## 利用可能なコマンド",
      "- curl: 8.14.1",
      "実際に検出できたコマンドだけを表示します。",
    ].join("\n"),
  );
});

test("health が無くても行を残し、前回値の断り書きを見出しの直後に出す", () => {
  const text = runtimeDiagnosticText({
    health: null,
    healthFailed: true,
    inUse: { status: "ready", value: IN_USE },
    environment: { status: "loading" },
  });

  assert.ok(text.includes("## 接続状態\n" + HEALTH_RELOAD_FAILED_MESSAGE), "見出しの直後に断り書きを出す");
  assert.ok(text.includes("- ランタイム: 情報なし"));
  assert.ok(text.includes("- サンドボックス: 情報なし"));
  assert.ok(text.includes("- 作業ディレクトリ (cwd): 情報なし"));
  assert.ok(text.includes("- セッションストア: 情報なし"));
  assert.ok(text.includes("- アプリ DB: 情報なし"));
  assert.ok(text.includes("- pi-coding-agent: 情報なし"));
  assert.ok(text.includes("- 既定モデル: 情報なし"), "health 未取得を未設定と書かない");
  assert.ok(!text.includes("- pi-ai:"), "値が無いバージョン行は出さない");
  assert.ok(!text.includes("- COMMIT_HASH:"), "値が無いバージョン行は出さない");
});

test("取得できていないセクションは状態文言を出し、黙って省かない", () => {
  const loading = runtimeDiagnosticText({
    health: HEALTH,
    healthFailed: false,
    inUse: { status: "loading" },
    environment: { status: "loading" },
  });
  assert.ok(loading.includes(RUNTIME_MODELS_LOADING));
  assert.ok(loading.includes(RUNTIME_INTEGRATIONS_LOADING));
  assert.ok(loading.includes("実行環境を取得しています。"));
  assert.ok(loading.includes("コマンドを検出しています。"));

  const failedInUse = runtimeDiagnosticText({
    health: HEALTH,
    healthFailed: false,
    inUse: { status: "error", message: "アプリデータ（SQLite）を利用できません" },
    environment: { status: "ready", value: CONNECTED },
  });
  assert.ok(failedInUse.includes(`${RUNTIME_MODELS_ERROR_LEAD}アプリデータ（SQLite）を利用できません`));
  assert.ok(failedInUse.includes(RUNTIME_INTEGRATIONS_UNAVAILABLE), "外部連携側は非表示の理由を出す");
  assert.ok(failedInUse.includes("- 接続状態: 接続中"), "取得できている実行環境は残す");

  const failedEnvironment = runtimeDiagnosticText({
    health: HEALTH,
    healthFailed: false,
    inUse: { status: "ready", value: IN_USE },
    environment: { status: "error", message: "サンドボックスの診断が期限内に応答しませんでした。" },
  });
  assert.ok(
    failedEnvironment.includes("実行環境を取得できませんでした。サンドボックスの診断が期限内に応答しませんでした。"),
  );
  assert.ok(failedEnvironment.includes("実行環境の情報を取得できていないため、コマンドは表示していません。"));
  assert.ok(failedEnvironment.includes("- Web 検索: tavily"), "取得できている外部連携は残す");

  const multiline = runtimeDiagnosticText({
    health: HEALTH,
    healthFailed: false,
    inUse: { status: "error", message: "1 行目\n2 行目" },
    environment: { status: "error", message: "1 行目\n2 行目" },
  });
  assert.ok(multiline.includes(`${RUNTIME_MODELS_ERROR_LEAD}1 行目 2 行目`), "エラー文言の改行も畳む");
  assert.ok(multiline.includes("実行環境を取得できませんでした。1 行目 2 行目"), "エラー文言の改行も畳む");
});

test("未接続の状態は理由を注記として出し、環境とコマンドは非表示にする", () => {
  for (const state of STATES) {
    if (state === "connected") continue;
    const summary = runtimeEnvironmentSummary(state);
    const text = runtimeDiagnosticText({
      health: HEALTH,
      healthFailed: false,
      inUse: { status: "ready", value: IN_USE },
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
    inUse: { status: "ready", value: IN_USE },
    environment: {
      status: "ready",
      value: {
        state: "connected",
        environment: { os: "Debian", arch: "aarch64", user: "root", isRoot: true, workspace: "/workspace" },
        commands: [{ name: "xz", version: null }],
        landlock: { state: "unavailable", abi: null, minAbi: 3, reason: "wrapper_missing" },
      },
    },
  });

  assert.ok(text.includes("- 実行ユーザー: root（root）"));
  assert.ok(text.includes("（root で動いています。コンテナ外への影響を避けるため、非 root 実行を推奨します。）"));
  assert.ok(text.includes("- xz: バージョン不明"));
  assert.ok(text.includes("- Landlock: 利用不可（ラッパーが見つかりません"));

  const empty = runtimeDiagnosticText({
    health: HEALTH,
    healthFailed: false,
    inUse: { status: "ready", value: IN_USE },
    environment: {
      status: "ready",
      value: { state: "connected", environment: CONNECTED.environment, commands: [], landlock: CONNECTED.landlock },
    },
  });
  assert.ok(empty.includes("検出できたコマンドはありません。"));
  assert.ok(!empty.includes("実際に検出できたコマンドだけを表示します。"), "行が無いときは注記も出さない");
});

test("値の改行は空白へ畳み、コピー本文の行構造を壊さない", () => {
  const text = runtimeDiagnosticText({
    health: { ...HEALTH, cwd: "/work\nspace" },
    healthFailed: false,
    inUse: { status: "ready", value: { ...IN_USE, webSearch: { ...IN_USE.webSearch, host: "api\n.example" } } },
    environment: {
      status: "ready",
      value: {
        state: "connected",
        environment: { os: "Debian", arch: "x86_64", user: "node", isRoot: false, workspace: "/w" },
        commands: [{ name: "bash", version: "5.2.37\n(extra)" }],
        landlock: CONNECTED.landlock,
      },
    },
  });

  assert.ok(text.includes("- 作業ディレクトリ (cwd): /work space"));
  assert.ok(text.includes("- Web 検索: tavily（api .example · 有効）"));
  assert.ok(text.includes("- bash: 5.2.37 (extra)"));
});
