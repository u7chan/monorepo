// 設定 → エージェント（/settings/agents）の並べ替えの保存と反映。DOM を組まずに、
// ページが使う flow（client/src/lib/agentOrder.ts）と共有カタログの取得の世代（client/src/lib/catalogStore.ts）、
// フォーム初期化の判定（agentFormKey）だけを固定する。ここが崩れると、取消が保存を送る / 遅れて届いた取得が
// 確定した並びを巻き戻す / 並べ替えで入力中の下書きが消える、のいずれかが起きる。
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentOrderNoteKind, AgentOrderState } from "../src/lib/agentOrder";
import type { AgentDef, CatalogResponse } from "../src/types";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { ApiError } = await import("../src/api");
const { createAgentOrderFlow } = await import("../src/lib/agentOrder");
const { createCatalogStore } = await import("../src/lib/catalogStore");
const { agentFormKey } = await import("../src/components/agent-settings/AgentEditorForm");

function agent(id: string, name = id): AgentDef {
  return { id, name, description: "", systemPrompt: "", skillIds: [] };
}

/** ページと同じ形の flow を作り、呼ばれた順と状態の変化を記録する */
function createHarness(options: {
  ids: string[];
  save?: (ids: string[]) => Promise<string[]>;
  refresh?: () => Promise<unknown>;
}) {
  const saved: string[][] = [];
  const applied: string[][] = [];
  const notes: { kind: AgentOrderNoteKind; message: string }[] = [];
  const states: AgentOrderState[] = [];
  let current = [...options.ids];
  const flow = createAgentOrderFlow({
    ids: () => current,
    save: async (ids) => {
      saved.push([...ids]);
      return options.save ? await options.save(ids) : [...ids];
    },
    apply: (ids) => {
      applied.push([...ids]);
      current = [...ids];
    },
    refresh: () => (options.refresh ? options.refresh() : Promise.resolve()),
    note: (kind, message) => notes.push({ kind, message }),
    onChange: (state) => states.push(state),
  });
  return {
    flow,
    saved,
    applied,
    notes,
    states,
    current: () => current,
  };
}

test("確定は保存 → 即時反映 → 取り直しの順で走り、下書きを残さない", async () => {
  const harness = createHarness({ ids: ["a", "b", "c"] });
  harness.flow.preview(["c", "a", "b"]);
  assert.deepEqual(harness.flow.state(), { draft: ["c", "a", "b"], saving: false }, "ドラッグ中は下書きを持つ");

  const committing = harness.flow.commit();
  assert.deepEqual(harness.saved, [["c", "a", "b"]]);
  assert.equal(harness.flow.state().saving, true, "保存中は次のドラッグを始めさせない");
  await committing;
  assert.deepEqual(harness.applied, [["c", "a", "b"]], "取り直しの応答を待たずに反映する");
  assert.deepEqual(harness.flow.state(), { draft: null, saving: false });
  assert.deepEqual(harness.notes, []);
});

test("ドラッグしていない確定と、同じ順になった確定は保存を送らない", async () => {
  const harness = createHarness({ ids: ["a", "b", "c"] });
  await harness.flow.commit();
  assert.deepEqual(harness.saved, [], "下書きが無ければ送らない");

  harness.flow.preview(["a", "b", "c"]);
  await harness.flow.commit();
  assert.deepEqual(harness.saved, [], "同じ順に落としただけでは送らない");
  assert.deepEqual(harness.applied, []);
});

test("取消は保存を送らず、下書きだけを捨てる", async () => {
  const harness = createHarness({ ids: ["a", "b", "c"] });
  harness.flow.preview(["b", "a", "c"]);
  harness.flow.cancel();
  assert.deepEqual(harness.flow.state(), { draft: null, saving: false });
  assert.deepEqual(harness.states.at(-1), { draft: null, saving: false }, "ページへ最新の状態を配る");
  assert.deepEqual(harness.saved, []);
  assert.deepEqual(harness.applied, []);
});

test("HTTP エラーは保存されていないので元の順へ戻して理由を出す", async () => {
  const harness = createHarness({
    ids: ["a", "b", "c"],
    save: () => Promise.reject(new ApiError("並びを保存できません", 503)),
  });
  harness.flow.preview(["b", "c", "a"]);
  await harness.flow.commit();
  assert.deepEqual(harness.flow.state(), { draft: null, saving: false }, "元の順へ戻す");
  assert.deepEqual(harness.applied, []);
  assert.deepEqual(
    harness.notes.map((note) => note.kind),
    ["rejected"],
  );
});

test("応答が返らない失敗は結果不明として表示を戻さず、次の取得に合わせる", async () => {
  const harness = createHarness({
    ids: ["a", "b", "c"],
    save: () => Promise.reject(new TypeError("Failed to fetch")),
  });
  harness.flow.preview(["b", "c", "a"]);
  await harness.flow.commit();
  // 保存できたか分からないので、ドラッグした並びを見せたまま注記だけを出す
  assert.deepEqual(harness.flow.state(), { draft: ["b", "c", "a"], saving: false });
  assert.deepEqual(harness.applied, []);
  assert.deepEqual(
    harness.notes.map((note) => note.kind),
    ["unknown"],
  );
});

test("確定後の取り直しに失敗しても並びは戻さず、取り直せないことだけを伝える", async () => {
  const harness = createHarness({
    ids: ["a", "b", "c"],
    save: (ids) => Promise.resolve(["c", ...ids.filter((id) => id !== "c")]),
    refresh: () => Promise.reject(new Error("一覧を取得できません")),
  });
  harness.flow.preview(["c", "a", "b"]);
  await harness.flow.commit();
  assert.deepEqual(harness.flow.state(), { draft: null, saving: false });
  assert.deepEqual(harness.current(), ["c", "a", "b"], "サーバーの採用順のまま");
  assert.deepEqual(
    harness.notes.map((note) => note.kind),
    ["refresh"],
  );
});

test("保存中の再確定は直列化され、古い操作が最終値にならない", async () => {
  let release!: (ids: string[]) => void;
  const harness = createHarness({
    ids: ["a", "b", "c"],
    save: () =>
      new Promise<string[]>((resolve) => {
        release = resolve;
      }),
  });
  harness.flow.preview(["c", "a", "b"]);
  const first = harness.flow.commit();
  harness.flow.preview(["b", "c", "a"]);
  assert.deepEqual(harness.flow.state().draft, ["c", "a", "b"], "保存中は下書きを差し替えない");
  await harness.flow.commit();
  assert.equal(harness.saved.length, 1, "2 回目は送らない");
  release(["c", "a", "b"]);
  await first;
  assert.deepEqual(harness.flow.state(), { draft: null, saving: false });
});

// --- 共有カタログの取得の世代 ---

function catalog(agentIds: string[]): CatalogResponse {
  return { builtinAgent: null, builtinSkills: [], agents: agentIds.map((id) => agent(id)), skills: [], tools: [] };
}

test("並べ替えより前に開始した取得の応答は確定順を巻き戻さない", () => {
  const store = createCatalogStore(catalog(["a", "b", "c"]));
  // 編集の保存が起こす取り直し (refreshCatalog) を遅延させる
  const applySlowFetch = store.begin();
  store.adoptOrder(["c", "a", "b"]);

  assert.equal(applySlowFetch(catalog(["a", "b", "c"])), false, "先行する取得は採用しない");
  assert.deepEqual(
    store.get().agents.map((entry) => entry.id),
    ["c", "a", "b"],
  );

  // 確定より後に開始した取得 (確定後の取り直し) は採用される
  const applyNextFetch = store.begin();
  assert.equal(applyNextFetch(catalog(["b", "a", "c"])), true);
  assert.deepEqual(
    store.get().agents.map((entry) => entry.id),
    ["b", "a", "c"],
  );

  // 後から開始した取得どうしでも、先行した側は捨てる
  const applyOlder = store.begin();
  const applyNewer = store.begin();
  assert.equal(applyOlder(catalog(["a", "b", "c"])), false);
  assert.equal(applyNewer(catalog(["a", "c", "b"])), true);
  assert.deepEqual(
    store.get().agents.map((entry) => entry.id),
    ["a", "c", "b"],
  );
});

test("確定順の反映は定義をそのまま使い、購読へ 1 回だけ配る", () => {
  const store = createCatalogStore(catalog(["a", "b", "c"]));
  const before = store.get().agents;
  let notified = 0;
  const unsubscribe = store.subscribe(() => {
    notified += 1;
  });
  store.adoptOrder(["c", "b", "a"]);
  assert.equal(notified, 1);
  assert.deepEqual(
    store.get().agents.map((entry) => entry.id),
    ["c", "b", "a"],
  );
  assert.equal(store.get().agents[0], before[2], "定義オブジェクトはコピーしない (並びだけを差し替える)");
  unsubscribe();
  store.adoptOrder(["a", "b", "c"]);
  assert.equal(notified, 1, "購読解除後は配らない");
});

// --- フォーム初期化の判定 ---

test("フォームの初期化は定義の参照ではなく内容で判定する", () => {
  const saved = agent("a", "レビュー");
  // 同じ内容でも別のオブジェクト (確定後の取り直しが返す形) では初期化しない
  const refetched = JSON.parse(JSON.stringify(saved)) as AgentDef;
  assert.notEqual(refetched, saved);
  assert.equal(agentFormKey(refetched), agentFormKey(saved));

  // 順序だけが変わっても、編集対象の内容は変わらない
  assert.equal(agentFormKey(saved), agentFormKey(agent("a", "レビュー")));
  // 内容が変われば初期化する
  assert.notEqual(agentFormKey(saved), agentFormKey({ ...saved, name: "レビュー 改" }));
  assert.notEqual(agentFormKey(saved), agentFormKey({ ...saved, suggestions: [{ label: "x", prompt: "y" }] }));
  // 新規 (未保存) の下書きは空どうしで同じ
  assert.equal(agentFormKey(undefined), agentFormKey(undefined));
});
