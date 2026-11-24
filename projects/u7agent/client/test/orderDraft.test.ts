// 設定の一覧の並べ替えの下書きと保存中の状態（client/src/lib/orderDraft.ts）。DOM も api も読み込まない
// 純関数だけを固定する。ここが崩れると、取消が保存を送る / 保存中のドラッグが下書きを差し替える /
// 結果不明の下書きを捨てたときに保存中の印まで落ちる、のいずれかが起きる。
import assert from "node:assert/strict";
import test from "node:test";
import { createOrderDraft, type OrderDraftState } from "../src/lib/orderDraft";

/** ページと同じ形で組み、`onChange` へ渡った状態の並びを記録する */
function createHarness(ids: string[]) {
  const states: OrderDraftState[] = [];
  const draft = createOrderDraft({
    ids: () => ids,
    onChange: (state) => states.push(state),
  });
  return { draft, states };
}

test("preview は下書きを差し替えて配り、cancel は下書きだけを捨てる", () => {
  const harness = createHarness(["a", "b", "c"]);
  assert.equal(harness.draft.preview(["c", "a", "b"]), true);
  assert.deepEqual(harness.draft.state(), { draft: ["c", "a", "b"], saving: false });
  assert.deepEqual(harness.states, [{ draft: ["c", "a", "b"], saving: false }], "ページへ最新の状態を配る");

  assert.equal(harness.draft.cancel(), true);
  assert.deepEqual(harness.draft.state(), { draft: null, saving: false });
  assert.deepEqual(harness.states.at(-1), { draft: null, saving: false });
  // 下書きが無いときの取消は何も配らない (再描画を起こさない)
  assert.equal(harness.draft.cancel(), false);
  assert.equal(harness.states.length, 2);
});

test("begin は動かした下書きだけを返し、保存中は受け付けない", () => {
  const harness = createHarness(["a", "b", "c"]);
  assert.equal(harness.draft.begin(), undefined, "ドラッグしていなければ送らない");

  harness.draft.preview(["a", "b", "c"]);
  assert.equal(harness.draft.begin(), undefined, "同じ順へ落としただけでは送らない");

  harness.draft.preview(["b", "a", "c"]);
  assert.deepEqual(harness.draft.begin(), ["b", "a", "c"]);
  assert.deepEqual(
    harness.draft.state(),
    { draft: ["b", "a", "c"], saving: true },
    "保存中は次のドラッグを始めさせない",
  );
  assert.equal(harness.draft.begin(), undefined, "2 回目は送らない (直列化)");

  // 保存中は live 差し替えを受け付けない
  assert.equal(harness.draft.preview(["c", "b", "a"]), false);
  assert.deepEqual(harness.draft.state().draft, ["b", "a", "c"]);
});

test("finish は確定と結果不明を、保存中の印ごと反映する", () => {
  const harness = createHarness(["a", "b", "c"]);
  harness.draft.preview(["b", "a", "c"]);
  const ids = harness.draft.begin();
  assert.deepEqual(ids, ["b", "a", "c"]);

  // 結果不明 (応答が返らない失敗) は、ドラッグした並びを見せたまま次のドラッグを開く
  harness.draft.finish(ids ?? []);
  assert.deepEqual(harness.draft.state(), { draft: ["b", "a", "c"], saving: false });

  harness.draft.finish(null);
  assert.deepEqual(harness.draft.state(), { draft: null, saving: false }, "確定すると下書きを残さない");
});

test("discard は下書きだけを捨て、保存中の印は残す", () => {
  const harness = createHarness(["a", "b", "c"]);
  harness.draft.preview(["b", "a", "c"]);
  assert.deepEqual(harness.draft.begin(), ["b", "a", "c"]);
  // 結果不明のまま再確定した最中に、サーバーの正が届いた場合。保存はまだ終わっていないので saving は残す
  harness.draft.discard();
  assert.deepEqual(harness.draft.state(), { draft: null, saving: true });
  // 下書きが無いときは何も配らない
  const before = harness.states.length;
  harness.draft.discard();
  assert.equal(harness.states.length, before);
});

test("返した状態を書き換えても、下書きは変わらない", () => {
  const harness = createHarness(["a", "b", "c"]);
  harness.draft.preview(["b", "a", "c"]);
  const state = harness.draft.state();
  state.draft?.push("d");
  harness.states.at(-1)?.draft?.push("e");
  assert.deepEqual(harness.draft.state().draft, ["b", "a", "c"]);
  // 保存へ渡す配列を書き換えても、送っている下書きは変わらない
  const ids = harness.draft.begin();
  ids?.push("d");
  assert.deepEqual(harness.draft.state().draft, ["b", "a", "c"]);
});
