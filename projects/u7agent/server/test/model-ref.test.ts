import assert from "node:assert/strict";
import test from "node:test";
import { formatModelRef, modelKey, modelLabel, parseModelRef } from "../src/model-ref";

test("モデルのラベルは ID 内の / や unknown をそのまま返し、参照がなければ省略する", () => {
  assert.equal(formatModelRef({ provider: "router", id: "vendor/model" }), "router/vendor/model");
  assert.equal(modelLabel({ provider: "unknown", id: "unknown" }), "unknown/unknown");
  assert.equal(modelLabel(null), undefined);
  assert.equal(modelLabel(), undefined);
});

test("モデルの比較キーは provider と ID の境界を保持する", () => {
  const ref = { provider: "router", id: "vendor/model" };
  const other = { provider: "router/vendor", id: "model" };
  assert.equal(formatModelRef(ref), formatModelRef(other));
  assert.equal(modelKey(ref), modelKey({ ...ref }));
  assert.notEqual(modelKey(ref), modelKey(other));
});

test("保存済みモデルの参照は最初の / だけで分け、空白をそのまま保持する", () => {
  assert.deepEqual(parseModelRef("router/vendor/model"), { provider: "router", id: "vendor/model" });
  assert.deepEqual(parseModelRef(" router / vendor/model "), { provider: " router ", id: " vendor/model " });
  assert.deepEqual(parseModelRef("router/ "), { provider: "router", id: " " });
});

test("保存済みモデルの参照に provider または ID がなければ値を返さない", () => {
  for (const value of [undefined, null, "", "router", "/model", "router/"]) {
    assert.equal(parseModelRef(value), undefined);
  }
});
