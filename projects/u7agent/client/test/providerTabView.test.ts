// What: プロバイダータブの選択状態。カスタムプロバイダーの追加フォームと provider 詳細を同時に出さないこと
// (追加フォーム表示中の行クリックでフォームが閉じ、その行の詳細が開くこと) を固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_TAB_INITIAL_VIEW, providerTabView } from "../src/lib/providerTabView";

test("追加フォームを開くと provider 詳細の選択は外れる", () => {
  const selected = providerTabView(PROVIDER_TAB_INITIAL_VIEW, { type: "select-row", key: "provider:local" });
  assert.deepEqual(providerTabView(selected, { type: "start-add" }), { selectedKey: null, addingCustom: true });
});

test("追加フォーム表示中の行クリックはフォームを閉じ、その行の詳細を開く", () => {
  const adding = providerTabView(PROVIDER_TAB_INITIAL_VIEW, { type: "start-add" });
  assert.deepEqual(providerTabView(adding, { type: "select-row", key: "provider:anthropic" }), {
    selectedKey: "provider:anthropic",
    addingCustom: false,
  });
});

test("カスタム定義の登録完了は、その詳細を開いて追加フォームを閉じる", () => {
  const adding = providerTabView(PROVIDER_TAB_INITIAL_VIEW, { type: "start-add" });
  assert.deepEqual(providerTabView(adding, { type: "select-row", key: "custom:local-llm" }), {
    selectedKey: "custom:local-llm",
    addingCustom: false,
  });
});

test("追加の中止・削除は追加フォームを閉じ、既定の provider 詳細へ戻す", () => {
  const adding = providerTabView(PROVIDER_TAB_INITIAL_VIEW, { type: "start-add" });
  assert.deepEqual(providerTabView(adding, { type: "reset" }), { selectedKey: null, addingCustom: false });
});
