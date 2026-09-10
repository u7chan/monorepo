// SDK 公開ヘルパー (getSupportedThinkingLevels / clampThinkingLevel) の
// オフライン検証。BFF 側で能力表を模倣していないことを担保する。
import assert from "node:assert/strict";
import test from "node:test";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { STUB_HOLE_MODEL, STUB_MODEL, STUB_PLAIN_MODEL } from "./stub-pi";

test("non-reasoning models only support off", () => {
  assert.equal(STUB_PLAIN_MODEL.reasoning, false);
  assert.deepEqual(getSupportedThinkingLevels(STUB_PLAIN_MODEL), ["off"]);
  // どの段階を要求しても off へ補正される
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    assert.equal(clampThinkingLevel(STUB_PLAIN_MODEL, level), "off");
  }
});

test("reasoning models expose base levels but xhigh/max only when mapped", () => {
  assert.deepEqual(getSupportedThinkingLevels(STUB_MODEL), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
  ]);
  // xhigh / max は thinkingLevelMap が明示されているときだけ候補になる
  assert.equal(clampThinkingLevel(STUB_MODEL, "xhigh"), "high");
  assert.equal(clampThinkingLevel(STUB_MODEL, "max"), "high");
  assert.equal(clampThinkingLevel(STUB_MODEL, "medium"), "medium");
  // 候補より低い段階はそのまま (補正はしない)
  assert.equal(clampThinkingLevel(STUB_MODEL, "minimal"), "minimal");
});

test("a null entry in thinkingLevelMap removes the level and leaves a gap", () => {
  assert.deepEqual(getSupportedThinkingLevels(STUB_HOLE_MODEL), [
    "off",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  // 穴 (minimal) を要求すると、SDK は次に大きい対応段階へ寄せる
  assert.equal(clampThinkingLevel(STUB_HOLE_MODEL, "minimal"), "low");
  assert.equal(clampThinkingLevel(STUB_HOLE_MODEL, "max"), "xhigh");
});
