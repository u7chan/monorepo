// 設定 → モデルのカスタムプロバイダーの純関数。フォーム検証・送信本文・注意文言・削除確認を固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  CUSTOM_PROVIDER_CONTEXT_WINDOW_NOTE,
  CUSTOM_PROVIDER_CREATED_NOTE,
  CUSTOM_PROVIDER_DEGRADED_APPLY_LABEL,
  CUSTOM_PROVIDER_DEGRADED_APPLY_NOTE,
  CUSTOM_PROVIDER_DEGRADED_REMOVE_LABEL,
  CUSTOM_PROVIDER_DEGRADED_REMOVE_NOTE,
  CUSTOM_PROVIDER_UNSYNCED_NOTE,
  CUSTOM_PROVIDER_CONTEXT_WINDOW_PRESETS,
  CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS,
  CUSTOM_PROVIDER_NOTES,
  CUSTOM_PROVIDER_NOTES_SUMMARY,
  CUSTOM_PROVIDER_PROBE_EMPTY_MESSAGE,
  contextWindowLabel,
  contextWindowOptions,
  customProviderBadge,
  customProviderDegradedNotice,
  customProviderEditable,
  customProviderMutationNote,
  customProviderSelectionKey,
  providerSelectionKey,
  currentCustomProviderProbe,
  customProviderBaseUrlError,
  customProviderCreateBody,
  customProviderDraftOf,
  customProviderFormHasError,
  customProviderProbeBody,
  customProviderProbeDisplay,
  customProviderProbeEnabled,
  customProviderProbeOutcome,
  customProviderUpdateBody,
  deleteCustomProviderConfirm,
  emptyCustomProviderDraft,
  filterModelIds,
  modelIdMissingFromList,
  validateCustomProviderDraft,
  type CustomProviderFormDraft,
} from "../src/lib/customProviders";
import type { CustomProviderProbeResponse, CustomProviderSummary } from "../src/types";

const SUMMARY: CustomProviderSummary = {
  id: "local-llm",
  name: "自宅のLLM",
  baseUrl: "http://192.0.2.10:11434/v1",
  api: "openai-completions",
  model: { id: "qwen2.5-coder:7b", contextWindow: 32768, maxTokens: 8192 },
  hasKey: true,
};

function draft(overrides: Partial<CustomProviderFormDraft> = {}): CustomProviderFormDraft {
  return {
    id: "local-llm",
    name: "",
    baseUrl: "http://192.0.2.10:11434/v1",
    apiKey: "sk-custom-dummy-key-0123456789",
    modelId: "qwen2.5-coder:7b",
    contextWindow: "32768",
    maxTokens: "",
    ...overrides,
  };
}

test("入力がそろっていれば検証を通る (作成・編集とも)", () => {
  assert.deepEqual(validateCustomProviderDraft(draft(), { editing: false }), {});
  assert.deepEqual(validateCustomProviderDraft(draft({ apiKey: "" }), { editing: true }), {});
});

test("provider id は作成時だけ形を検証する (編集時は読み取り専用)", () => {
  const cases = ["", "Local", "1local", "-x", "x-", "local_llm", "a/b", "a".repeat(65)];
  for (const id of cases) {
    assert.ok(validateCustomProviderDraft(draft({ id }), { editing: false }).id, `${id} は作成で拒否する`);
  }
  assert.equal(validateCustomProviderDraft(draft({ id: "a".repeat(64) }), { editing: false }).id, undefined);
  assert.deepEqual(validateCustomProviderDraft(draft({ id: "broken id" }), { editing: true }), {});
});

test("baseUrl は http / https だけを通し、userinfo・query・fragment を拒否する", () => {
  assert.equal(customProviderBaseUrlError("http://192.0.2.10:11434/v1/"), undefined);
  assert.equal(customProviderBaseUrlError("https://llm.example.test"), undefined);
  for (const baseUrl of [
    "",
    "llm.example.test/v1",
    "ftp://192.0.2.10/v1",
    "http://user:pass@192.0.2.10/v1",
    "http://192.0.2.10/v1?x=1",
    "http://192.0.2.10/v1#x",
  ]) {
    assert.ok(customProviderBaseUrlError(baseUrl), `${baseUrl} は拒否する`);
  }
});

test("APIキーは作成で必須・8..2048 文字、編集では空欄を既存の維持として許す", () => {
  assert.ok(validateCustomProviderDraft(draft({ apiKey: "" }), { editing: false }).apiKey);
  assert.ok(validateCustomProviderDraft(draft({ apiKey: "short" }), { editing: false }).apiKey);
  assert.ok(validateCustomProviderDraft(draft({ apiKey: "a".repeat(2049) }), { editing: true }).apiKey);
  assert.equal(validateCustomProviderDraft(draft({ apiKey: "" }), { editing: true }).apiKey, undefined);
});

test("モデル ID は空白なし・200 文字まで、contextWindow は必須の正の整数、maxTokens は任意", () => {
  assert.ok(validateCustomProviderDraft(draft({ modelId: " " }), { editing: false }).modelId);
  assert.ok(validateCustomProviderDraft(draft({ modelId: "qwen 7b" }), { editing: false }).modelId);
  assert.ok(validateCustomProviderDraft(draft({ modelId: "a".repeat(201) }), { editing: false }).modelId);
  assert.equal(
    validateCustomProviderDraft(draft({ modelId: "meta-llama/Llama-3:8b" }), { editing: false }).modelId,
    undefined,
  );

  assert.ok(validateCustomProviderDraft(draft({ contextWindow: "" }), { editing: false }).contextWindow);
  for (const contextWindow of ["0", "-1", "1.5", "abc"]) {
    assert.ok(
      validateCustomProviderDraft(draft({ contextWindow }), { editing: false }).contextWindow,
      `${contextWindow} は拒否する`,
    );
  }
  assert.ok(validateCustomProviderDraft(draft({ maxTokens: "0" }), { editing: false }).maxTokens);
  assert.equal(validateCustomProviderDraft(draft({ maxTokens: "" }), { editing: false }).maxTokens, undefined);
  assert.equal(validateCustomProviderDraft(draft({ maxTokens: "4096" }), { editing: false }).maxTokens, undefined);
  assert.equal(customProviderFormHasError({}), false);
  assert.equal(customProviderFormHasError({ baseUrl: "x" }), true);
  assert.ok(CUSTOM_PROVIDER_CONTEXT_WINDOW_NOTE.includes("context window"));
});

test("contextWindow の選択肢は 8K〜512K を `xxK (raw)` で並べる", () => {
  assert.deepEqual(
    CUSTOM_PROVIDER_CONTEXT_WINDOW_PRESETS.map((value) => contextWindowLabel(value)),
    [
      "8K (8,192)",
      "16K (16,384)",
      "32K (32,768)",
      "64K (65,536)",
      "128K (131,072)",
      "256K (262,144)",
      "384K (393,216)",
      "512K (524,288)",
    ],
  );
  assert.deepEqual(
    contextWindowOptions("").map((option) => option.value),
    [...CUSTOM_PROVIDER_CONTEXT_WINDOW_PRESETS],
  );
  assert.deepEqual(
    contextWindowOptions("32768").map((option) => option.value),
    [...CUSTOM_PROVIDER_CONTEXT_WINDOW_PRESETS],
  );
});

test("プリセットに無い保存値は 1 件だけ足し、値の順に並べる (勝手に丸めない)", () => {
  const values = contextWindowOptions("200000").map((option) => option.value);
  assert.equal(values.length, CUSTOM_PROVIDER_CONTEXT_WINDOW_PRESETS.length + 1);
  assert.deepEqual(
    values,
    [...values].sort((a, b) => a - b),
  );
  assert.ok(values.includes(200_000));
  assert.equal(contextWindowLabel(200_000), "200,000", "1024 で割り切れない値は K に丸めない");
  assert.equal(contextWindowOptions("0").length, CUSTOM_PROVIDER_CONTEXT_WINDOW_PRESETS.length);
});

test("保存値の下書きは id と同じ名前を空にし、キーは空にする (空欄 = 維持)", () => {
  assert.deepEqual(customProviderDraftOf({ ...SUMMARY, name: SUMMARY.id }), {
    id: "local-llm",
    name: "",
    baseUrl: "http://192.0.2.10:11434/v1",
    apiKey: "",
    modelId: "qwen2.5-coder:7b",
    contextWindow: "32768",
    maxTokens: "8192",
  });
  assert.equal(customProviderDraftOf(SUMMARY).name, "自宅のLLM");
});

test("送信本文は空の任意項目を送らず、更新ではキーの空欄を送らない", () => {
  assert.deepEqual(customProviderCreateBody(draft()), {
    id: "local-llm",
    baseUrl: "http://192.0.2.10:11434/v1",
    apiKey: "sk-custom-dummy-key-0123456789",
    model: { id: "qwen2.5-coder:7b", contextWindow: 32768 },
  });
  assert.deepEqual(customProviderCreateBody(draft({ name: " 自宅のLLM " })), {
    id: "local-llm",
    name: "自宅のLLM",
    baseUrl: "http://192.0.2.10:11434/v1",
    apiKey: "sk-custom-dummy-key-0123456789",
    model: { id: "qwen2.5-coder:7b", contextWindow: 32768 },
  });
  assert.deepEqual(customProviderUpdateBody(draft({ apiKey: "", maxTokens: "4096" })), {
    baseUrl: "http://192.0.2.10:11434/v1",
    model: { id: "qwen2.5-coder:7b", contextWindow: 32768, maxTokens: 4096 },
  });
  assert.equal(customProviderUpdateBody(draft()).apiKey, "sk-custom-dummy-key-0123456789");
  assert.equal(CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS, 16384);
});

test("複数登録できる (下書きは独立し、provider ごとに別の本文を作る)", () => {
  const first = emptyCustomProviderDraft();
  const second = emptyCustomProviderDraft();
  first.id = "local-llm";
  first.baseUrl = "http://192.0.2.10:11434/v1";
  first.apiKey = "sk-custom-dummy-key-0123456789";
  first.modelId = "qwen2.5-coder:7b";
  first.contextWindow = "32768";
  second.id = "lab";
  second.baseUrl = "http://198.51.100.20:8000/v1";
  second.apiKey = "sk-lab-dummy-key-0123456789";
  second.modelId = "mistral:7b";
  second.contextWindow = "16384";

  assert.notEqual(first, second);
  assert.deepEqual([customProviderCreateBody(first).id, customProviderCreateBody(second).id], ["local-llm", "lab"]);
  assert.equal(customProviderCreateBody(second).model.contextWindow, 16384, "1 provider = 1 model");
});

test("常時の注意は DB 保存・暗号化・再起動後も残る・カタログ外・master key・キー必須を伝える", () => {
  const text = [CUSTOM_PROVIDER_NOTES_SUMMARY, ...CUSTOM_PROVIDER_NOTES].join("\n");
  assert.ok(text.includes("アプリ DB"), "保存先がアプリ DB であることを伝える");
  assert.ok(text.includes("暗号化"), "APIキーを暗号化して保存することを伝える");
  assert.ok(text.includes("再起動後も残ります"));
  assert.ok(text.includes("master key"), "復号できないときの扱いを伝える");
  assert.ok(text.includes("カタログ外"));
  assert.ok(text.includes("ダミー"));
  assert.ok(text.includes("Authorization: Bearer"));
  assert.ok(text.includes("信頼できる baseUrl"));
  // メモリのみ・再起動で消える、という旧仕様の説明を残さない
  for (const phrase of ["メモリにだけ保存", "メモリのみ", "再起動すると定義とAPIキーは消えます"]) {
    assert.ok(!text.includes(phrase), `${phrase} を残さない`);
  }
});

test("削除の確認は DB と runtime の両方から消えること・会話への影響・モデル選択の扱いを示す", () => {
  const request = deleteCustomProviderConfirm("自宅のLLM");
  assert.equal(request.kind, "confirm");
  assert.equal(request.danger, true);
  assert.deepEqual(request.subject, { label: "削除する provider", value: "自宅のLLM" });
  const text = (request.body ?? []).join("\n");
  assert.ok(text.includes("アプリ DB"));
  assert.ok(text.includes("実行中のランタイム"));
  assert.ok(text.includes("次回の送信"));
  assert.ok(text.includes("カタログ外"));
  for (const phrase of ["メモリから消えます", "DB には保存していません"]) {
    assert.ok(!text.includes(phrase), `${phrase} を残さない`);
  }
});

test("反映待ちのバッジと案内は degraded だけに出し、サーバーの固定文言を優先する", () => {
  const applied = { ...SUMMARY };
  assert.equal(customProviderBadge(applied), null, "反映済みはバッジを出さない");
  assert.equal(customProviderDegradedNotice(applied), null);
  assert.equal(customProviderEditable(applied), true);

  const pending = { ...SUMMARY, degraded: "apply" as const };
  assert.deepEqual(customProviderBadge(pending), { text: CUSTOM_PROVIDER_DEGRADED_APPLY_LABEL, warn: true });
  assert.equal(customProviderDegradedNotice(pending), CUSTOM_PROVIDER_DEGRADED_APPLY_NOTE);
  assert.equal(customProviderEditable(pending), true, "未反映でも編集・削除はできる (削除で抜けられる)");

  const serverMessage = "master key（U7AGENT_SECRET_MASTER_KEY）が未設定または不正です";
  assert.equal(
    customProviderDegradedNotice({ ...SUMMARY, degraded: "apply", degradedMessage: serverMessage }),
    serverMessage,
    "画面の既定文言ではなくサーバーの固定文言を優先する",
  );

  const removed = { ...SUMMARY, degraded: "remove" as const, degradedMessage: "ignored" };
  assert.deepEqual(customProviderBadge(removed), { text: CUSTOM_PROVIDER_DEGRADED_REMOVE_LABEL, warn: true });
  assert.equal(customProviderDegradedNotice(removed), CUSTOM_PROVIDER_DEGRADED_REMOVE_NOTE);
  assert.equal(customProviderEditable(removed), false, "削除待ちは再同期だけを出す");
});

test("一覧の選択キーは種別込みで、同じ id の built-in とカスタムを区別する", () => {
  assert.notEqual(providerSelectionKey("local-llm"), customProviderSelectionKey("local-llm"));
  assert.equal(providerSelectionKey("local-llm"), "provider:local-llm");
  assert.equal(customProviderSelectionKey("local-llm"), "custom:local-llm");
});

test("変更の注記は applied_unsynced のときだけ未反映の案内を出す", () => {
  assert.deepEqual(customProviderMutationNote(CUSTOM_PROVIDER_CREATED_NOTE, "applied"), {
    text: CUSTOM_PROVIDER_CREATED_NOTE,
    error: false,
  });
  assert.deepEqual(customProviderMutationNote(CUSTOM_PROVIDER_CREATED_NOTE, "applied_unsynced"), {
    text: CUSTOM_PROVIDER_UNSYNCED_NOTE,
    error: true,
  });
});

const PROBE_OK: CustomProviderProbeResponse = {
  checkedAt: 1,
  baseUrl: "http://192.0.2.10:11434/v1",
  failure: null,
  httpStatus: null,
  models: [{ id: "llama3:8b" }, { id: "qwen2.5-coder:7b" }],
  truncated: false,
  message: null,
};

test("probe の本文は編集時だけ provider を載せ、空欄のキーは送らない", () => {
  assert.deepEqual(customProviderProbeBody(draft(), false), {
    baseUrl: "http://192.0.2.10:11434/v1",
    apiKey: "sk-custom-dummy-key-0123456789",
  });
  assert.deepEqual(customProviderProbeBody(draft({ apiKey: " " }), true), {
    provider: "local-llm",
    baseUrl: "http://192.0.2.10:11434/v1",
    apiKey: " ",
  });
  assert.deepEqual(customProviderProbeBody(draft({ apiKey: "" }), true), {
    provider: "local-llm",
    baseUrl: "http://192.0.2.10:11434/v1",
  });
});

test("probe は保存と同じ境界に加え、編集時の空欄キーは保存済みキーがあるときだけ押せる", () => {
  const base = {
    draft: draft(),
    editing: false,
    hasStoredKey: false,
    runtimeAvailable: true,
    busy: false,
    probing: false,
  };
  assert.equal(customProviderProbeEnabled(base), true);
  assert.equal(customProviderProbeEnabled({ ...base, draft: draft({ baseUrl: "" }) }), false);
  assert.equal(customProviderProbeEnabled({ ...base, draft: draft({ apiKey: "short" }) }), false);
  assert.equal(
    customProviderProbeEnabled({ ...base, editing: true, draft: draft({ apiKey: "" }), hasStoredKey: true }),
    true,
  );
  assert.equal(
    customProviderProbeEnabled({ ...base, editing: true, draft: draft({ apiKey: "" }), hasStoredKey: false }),
    false,
  );
  assert.equal(customProviderProbeEnabled({ ...base, editing: false, draft: draft({ apiKey: "" }) }), false);
  assert.equal(customProviderProbeEnabled({ ...base, runtimeAvailable: false }), false);
  assert.equal(customProviderProbeEnabled({ ...base, busy: true }), false);
  assert.equal(customProviderProbeEnabled({ ...base, probing: true }), false);
});

test("一覧の絞り込みは大小を無視し、並びを保つ", () => {
  const ids = ["llama3:8b", "Qwen2.5-Coder:7b", "nomic-embed-text"];
  assert.deepEqual(filterModelIds(ids, ""), ids);
  assert.deepEqual(filterModelIds(ids, "QWEN"), ["Qwen2.5-Coder:7b"]);
  assert.deepEqual(filterModelIds(ids, "  embed  "), ["nomic-embed-text"]);
  assert.deepEqual(filterModelIds(ids, "missing"), []);
});

test("一覧に無いモデル ID は、空の入力と空の一覧では警告しない", () => {
  assert.equal(modelIdMissingFromList("llama3:8b", ["llama3:8b"]), false);
  assert.equal(modelIdMissingFromList(" other ", ["llama3:8b"]), true);
  assert.equal(modelIdMissingFromList("", ["llama3:8b"]), false);
  assert.equal(modelIdMissingFromList("other", []), false);
});

test("結果行は成功の件数と失敗のサーバー文言・HTTP status を出す", () => {
  assert.deepEqual(customProviderProbeDisplay(PROBE_OK), {
    kind: "success",
    message: "接続できました。モデル 2 件",
    detail: null,
  });
  assert.deepEqual(customProviderProbeDisplay({ ...PROBE_OK, truncated: true }), {
    kind: "success",
    message: "接続できました。モデル 2 件（先頭 2 件のみ）",
    detail: null,
  });
  assert.deepEqual(customProviderProbeDisplay({ ...PROBE_OK, models: [] }), {
    kind: "success",
    message: CUSTOM_PROVIDER_PROBE_EMPTY_MESSAGE,
    detail: null,
  });
  assert.deepEqual(
    customProviderProbeDisplay({
      ...PROBE_OK,
      failure: "unauthorized",
      httpStatus: 401,
      models: [],
      message: "接続先がAPIキーを拒否しました。キーを確認してください",
    }),
    {
      kind: "failure",
      message: "接続先がAPIキーを拒否しました。キーを確認してください",
      detail: "HTTP 401",
    },
  );
  assert.equal(
    customProviderProbeDisplay({ ...PROBE_OK, failure: "timeout", httpStatus: null, models: [], message: null }).detail,
    null,
  );
});

test("取得中に入力が変わったら、遅れて届いた一覧を picker に返さない", () => {
  const current = customProviderProbeOutcome({
    startedAt: 1,
    currentRevision: 1,
    result: PROBE_OK,
    error: null,
  });
  assert.deepEqual(current.ids, ["llama3:8b", "qwen2.5-coder:7b"]);
  assert.equal(current.state.revision, 1);

  const stale = customProviderProbeOutcome({
    startedAt: 1,
    currentRevision: 2,
    result: PROBE_OK,
    error: null,
  });
  assert.deepEqual(stale.ids, [], "変更後の入力へ古い endpoint の一覧を返さない");
  assert.equal(stale.state.result, PROBE_OK, "状態は revision 付きで残し、表示側で失効させる");

  const failed = customProviderProbeOutcome({
    startedAt: 1,
    currentRevision: 1,
    result: { ...PROBE_OK, failure: "unauthorized", httpStatus: 401, models: [], message: "no" },
    error: null,
  });
  assert.deepEqual(failed.ids, []);
  const error = customProviderProbeOutcome({ startedAt: 1, currentRevision: 1, result: null, error: "400" });
  assert.deepEqual(error.ids, []);
  assert.equal(error.state.error, "400");
});

test("baseUrl / APIキーを編集したら前の probe 結果は捨てる", () => {
  const result = { revision: 2, result: PROBE_OK, error: null };
  assert.equal(currentCustomProviderProbe(result, 2), result);
  assert.equal(currentCustomProviderProbe(result, 3), null);
  assert.equal(currentCustomProviderProbe(null, 0), null);
});
