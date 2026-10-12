// 未作成チャットの Model / Effort の先行選択 (client/src/hooks/preselection.ts) の寿命。
// 破棄の条件 (新しいチャット / 選択中エージェントの変更) と、作成の応答による消費が要求時の世代に
// 閉じること (応答待ちに選び直した値を、遅れて届いた応答が消さない) を固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { createPreselection } from "../src/hooks/preselection";

const model = (id: string) => ({ provider: "p", id });

test("選んだモデル / Effort を保持し、変更が無ければ同じ参照を返す", () => {
  const preselection = createPreselection();
  const initial = preselection.snapshot();

  preselection.update({});
  assert.equal(preselection.snapshot(), initial, "空の更新で再描画を作らない");

  preselection.update({ model: model("a") });
  assert.deepEqual(preselection.snapshot(), { model: model("a") });

  preselection.update({ thinkingLevel: "high" });
  assert.deepEqual(preselection.snapshot(), { model: model("a"), thinkingLevel: "high" }, "フィールド単位で重ねる");
});

test("作成の要求へ載せる値を読み、同じ世代の応答で消費する", () => {
  const preselection = createPreselection();
  preselection.update({ model: model("a") });

  const request = preselection.beginCreate();
  assert.deepEqual(request.selection, { model: model("a") });

  preselection.consume(request.generation);
  assert.deepEqual(preselection.snapshot(), {}, "作成の応答で消費する");
});

test("応答待ちに選び直した値は、遅れて届いた応答で消さない", () => {
  const preselection = createPreselection();
  preselection.update({ model: model("a") });
  const request = preselection.beginCreate();

  preselection.update({ model: model("b") });
  preselection.consume(request.generation);
  assert.deepEqual(preselection.snapshot(), { model: model("b") }, "世代が変わった要求では消費しない");
});

test("新しいチャットを開くと捨て、進行中の作成の応答で新しい選択を消させない", () => {
  const preselection = createPreselection();
  preselection.update({ model: model("a") });
  const request = preselection.beginCreate();

  preselection.reset();
  assert.deepEqual(preselection.snapshot(), {}, "未送信チャットの寿命に閉じる");
  preselection.update({ model: model("b") });
  preselection.consume(request.generation);
  assert.deepEqual(preselection.snapshot(), { model: model("b") });
});

test("選択中エージェントの変更で捨て、同じ ID の再取得では捨てない", () => {
  const preselection = createPreselection();
  // 起動時に観測した選択中エージェント
  preselection.syncAgent("agent-1");
  preselection.update({ model: model("a") });

  preselection.syncAgent("agent-1");
  assert.deepEqual(preselection.snapshot(), { model: model("a") }, "同じ ID では捨てない");

  preselection.syncAgent("agent-2");
  assert.deepEqual(preselection.snapshot(), {}, "カタログの正規化で id が変わったときも捨てる");
});

test("エージェントの変更で捨てた後、進行中の作成の応答で新しい選択を消させない", () => {
  const preselection = createPreselection();
  preselection.syncAgent("agent-1");
  preselection.update({ model: model("a") });
  const request = preselection.beginCreate();

  preselection.syncAgent("agent-2");
  preselection.update({ model: model("b") });
  preselection.consume(request.generation);
  assert.deepEqual(preselection.snapshot(), { model: model("b") });
});
