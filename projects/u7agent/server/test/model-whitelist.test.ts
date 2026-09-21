// PI_MODELS (whitelist) の構文解釈と available との積のオフライン検証。ランタイムや実 API は使わない。
import assert from "node:assert/strict";
import test from "node:test";
import { filterModelsByWhitelist, parseModelWhitelist } from "../src/agent";
import { STUB_MODEL, STUB_PLAIN_MODEL } from "./stub-pi";

const AVAILABLE = [STUB_MODEL, STUB_PLAIN_MODEL];

test("PI_MODELS 未指定なら全件のまま (後方互換)", () => {
  for (const raw of [undefined, "", "   ", ","]) {
    assert.equal(parseModelWhitelist(raw), undefined, `raw=${JSON.stringify(raw)}`);
  }
  assert.deepEqual(filterModelsByWhitelist(AVAILABLE, undefined), AVAILABLE);
});

test("PI_MODELS は provider/model のカンマ区切りを解釈する", () => {
  assert.deepEqual(parseModelWhitelist("stub/stub-model, stub/stub-plain"), [
    { provider: "stub", id: "stub-model" },
    { provider: "stub", id: "stub-plain" },
  ]);
  // model id に slash が含まれても先頭の slash だけで provider と分ける
  assert.deepEqual(parseModelWhitelist("openrouter/anthropic/claude-sonnet-4-5"), [
    { provider: "openrouter", id: "anthropic/claude-sonnet-4-5" },
  ]);
});

test("provider/model 形式でない PI_MODELS は起動時に落とす", () => {
  for (const raw of ["stub", "stub/", "/stub-model"]) {
    assert.throws(() => parseModelWhitelist(raw), /provider\/model/, `raw=${raw}`);
  }
});

test("available との積だけを残し、whitelist 外のモデルは選択肢から消える", () => {
  assert.deepEqual(
    filterModelsByWhitelist(AVAILABLE, [{ provider: "stub", id: "stub-plain" }]).map((model) => model.id),
    ["stub-plain"],
  );
  // 交差しない whitelist は候補ゼロ (呼び出し側が whitelist 起因のエラーにする)
  assert.deepEqual(filterModelsByWhitelist(AVAILABLE, [{ provider: "stub", id: "ghost" }]), []);
  assert.deepEqual(filterModelsByWhitelist(AVAILABLE, [{ provider: "openai", id: "stub-model" }]), []);
});
