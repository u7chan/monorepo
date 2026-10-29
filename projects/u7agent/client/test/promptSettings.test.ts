import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import {
  AGENT_PROMPT_LIMIT,
  atPromptLimit,
  promptDraftChanged,
  promptCandidates,
  promptDeleteBlockedReason,
  promptDraftError,
  promptDraftKey,
  promptDraftOf,
  promptDraftStateOf,
  promptMutationNote,
  promptPayloadOf,
  promptRefreshFailure,
  promptSelectionOf,
  promptUsageLabel,
  splitPromptsByKind,
  syncPromptDraft,
  withPromptMoved,
  withPromptRemoved,
  withPromptSelected,
} from "../src/lib/promptSettings";
import { promptDeleteConfirmRequest } from "../src/lib/settingsConfirm";
import type { AgentDef, PromptDef } from "../src/types";
import { PromptSelector } from "../src/components/agent-settings/PromptSelector";

const prompt = (id: string, overrides: Partial<PromptDef> = {}): PromptDef => ({
  id,
  kind: "custom",
  label: `ラベル ${id}`,
  prompt: `本文 ${id}`,
  usedBy: [],
  ...overrides,
});

test("下書きは編集対象の内容で初期化し、同じ内容の取り直しでは未保存の判定を変えない", () => {
  const target = prompt("p1");
  assert.deepEqual(promptDraftOf(target), { label: "ラベル p1", prompt: "本文 p1" });
  assert.deepEqual(promptDraftOf(undefined), { label: "", prompt: "" });
  const baseline = promptDraftKey(promptDraftOf(target));
  assert.equal(promptDraftChanged(promptDraftOf(target), baseline), false);
  // 同じ内容の別オブジェクト (サーバーの取り直し) でも未保存にしない
  assert.equal(promptDraftChanged(promptDraftOf(JSON.parse(JSON.stringify(target)) as PromptDef), baseline), false);
  assert.equal(promptDraftChanged({ label: "変更", prompt: "本文 p1" }, baseline), true);
  // 保存直後は一覧が古くても、保存した内容を基準にすれば未保存にならない
  const saved = { label: "保存した", prompt: "保存した本文" };
  assert.equal(promptDraftChanged(saved, promptDraftKey(saved)), false);
});

test("保存前の検証とペイロードは前後の空白を落とす", () => {
  assert.equal(promptDraftError({ label: "  ", prompt: "本文" }), "ラベルを入力してください。");
  assert.equal(promptDraftError({ label: "ラベル", prompt: " " }), "プロンプトを入力してください。");
  assert.equal(promptDraftError({ label: "ラベル", prompt: "本文" }), undefined);
  assert.deepEqual(promptPayloadOf({ label: "  ラベル ", prompt: "\n本文\n" }), {
    label: "ラベル",
    prompt: "本文",
  });
});

test("失敗して保持した古い一覧は、保存成立後の下書きと基準を巻き戻さない", () => {
  const stale = prompt("p1", { label: "既存一", prompt: "既存の本文" });
  const saved = { label: "保存済み", prompt: "既存の本文" };
  const state = promptDraftStateOf("p1", saved);

  // 一覧の再取得に失敗している間は、保持している旧い一覧で初期化しない
  assert.equal(syncPromptDraft(state, { editingId: "p1", prompt: stale, authoritative: false }), state);
  // 取得成功でも保存した内容と同じなら何もしない
  const same = prompt("p1", saved);
  assert.equal(syncPromptDraft(state, { editingId: "p1", prompt: same, authoritative: true }), state);
  // 保存直後は未保存ではない (フォームの内容と基準が一致する)
  assert.equal(promptDraftChanged(state.draft, state.key), false);
});

test("取得成功の一覧では、未編集の下書きだけ他端末の変更へ追随する", () => {
  const state = promptDraftStateOf("p1", { label: "既存一", prompt: "既存の本文" });
  const changed = prompt("p1", { label: "他端末", prompt: "他端末の本文" });
  const adopted = syncPromptDraft(state, { editingId: "p1", prompt: changed, authoritative: true });
  assert.deepEqual(adopted.draft, { label: "他端末", prompt: "他端末の本文" });
  assert.equal(adopted.key, promptDraftKey({ label: "他端末", prompt: "他端末の本文" }));

  // 編集している途中の内容は、取得成功の再取得でも上書きしない
  const editing = { ...state, draft: { label: "編集中", prompt: "編集中の本文" } };
  assert.equal(syncPromptDraft(editing, { editingId: "p1", prompt: changed, authoritative: true }), editing);
});

test("対象が変われば一覧の内容から初期化し、対象なしへ戻ると空にする", () => {
  const first = promptDraftStateOf("p1", { label: "一", prompt: "一の本文" });
  const second = prompt("p2", { label: "二", prompt: "二の本文" });
  // 失敗して保持した古い一覧でも、選択した対象の内容からは初期化する
  const moved = syncPromptDraft(first, { editingId: "p2", prompt: second, authoritative: false });
  assert.deepEqual(moved, promptDraftStateOf("p2", { label: "二", prompt: "二の本文" }));

  const cleared = syncPromptDraft(moved, { editingId: null, prompt: undefined, authoritative: false });
  assert.equal(cleared.id, null);
  assert.deepEqual(cleared.draft, { label: "", prompt: "" });
  // 新規の下書き中输入した内容は、対象が無い間そのまま
  const typing = { ...cleared, draft: { label: "新規", prompt: "新規の本文" } };
  assert.equal(syncPromptDraft(typing, { editingId: null, prompt: undefined, authoritative: true }), typing);
});

test("保存 / 削除の成立と再取得の失敗を混ぜず、失敗の理由だけを添える", () => {
  assert.deepEqual(promptMutationNote("saved", undefined), {
    text: "定型プロンプトを保存しました。",
    error: false,
  });
  assert.deepEqual(promptMutationNote("saved", "一覧を取り直せませんでした。503"), {
    text: "定型プロンプトを保存しましたが、一覧を取り直せませんでした。503",
    error: true,
  });
  assert.deepEqual(promptMutationNote("deleted", "エージェントのカタログを取り直せませんでした。503"), {
    text: "定型プロンプトを削除しましたが、エージェントのカタログを取り直せませんでした。503",
    error: true,
  });

  assert.equal(promptRefreshFailure(undefined, undefined), undefined);
  assert.equal(promptRefreshFailure("503", undefined), "一覧を取り直せませんでした。503");
  assert.equal(promptRefreshFailure(undefined, "503"), "エージェントのカタログを取り直せませんでした。503");
  assert.equal(
    promptRefreshFailure("503", "502"),
    "一覧を取り直せませんでした。503 エージェントのカタログを取り直せませんでした。502",
  );
});

test("使用先の表示と削除できない理由を区別する", () => {
  assert.equal(
    promptUsageLabel({ agentId: "agent-general", agentName: "汎用アシスタント", builtin: true }),
    "汎用アシスタント（組み込み）",
  );
  assert.equal(promptUsageLabel({ agentId: "a1", agentName: "調査", builtin: false }), "調査");

  const unused = prompt("p1");
  assert.equal(promptDeleteBlockedReason(unused), undefined);
  const used = prompt("p2", { usedBy: [{ agentId: "a1", agentName: "調査", builtin: false }] });
  assert.match(promptDeleteBlockedReason(used) ?? "", /調査/);
  assert.match(promptDeleteBlockedReason(used) ?? "", /解除/);
  const builtin = prompt("p3", { kind: "builtin" });
  assert.match(promptDeleteBlockedReason(builtin) ?? "", /組み込み/);
});

test("一覧は種別で分けられ、候補は全件をそのまま扱う", () => {
  const prompts = [prompt("b1", { kind: "builtin" }), prompt("c1"), prompt("c2")];
  assert.deepEqual(
    splitPromptsByKind(prompts).custom.map((entry) => entry.id),
    ["c1", "c2"],
  );
  assert.deepEqual(
    splitPromptsByKind(prompts).builtin.map((entry) => entry.id),
    ["b1"],
  );
  assert.deepEqual(
    promptCandidates(prompts).map((entry) => entry.id),
    ["b1", "c1", "c2"],
  );
});

test("エージェントの参照は選択・解除・並べ替えの順序を保ち、上限で追加しない", () => {
  const ids = ["p1", "p2", "p3"];
  assert.deepEqual(withPromptSelected(ids, "p4"), ["p1", "p2", "p3", "p4"]);
  // 同じ ID は二重に足さない (同じ本文の別マスタは ID が違うので両方入る)
  assert.deepEqual(withPromptSelected(ids, "p1"), ids);
  assert.deepEqual(withPromptRemoved(ids, "p2"), ["p1", "p3"]);

  const full = Array.from({ length: AGENT_PROMPT_LIMIT }, (_, index) => `p${index}`);
  assert.equal(atPromptLimit(full), true);
  assert.deepEqual(withPromptSelected(full, "extra"), full, "上限では追加しない");

  assert.deepEqual(withPromptMoved(ids, "p1", 1), ["p2", "p1", "p3"]);
  assert.deepEqual(withPromptMoved(ids, "p3", -1), ["p1", "p3", "p2"]);
  // 端では動かさない
  assert.deepEqual(withPromptMoved(ids, "p1", -1), ids);
  assert.deepEqual(withPromptMoved(ids, "p3", 1), ids);
});

test("エージェントの参照は解決済みの並びから取り出す", () => {
  const agent: AgentDef = {
    id: "a1",
    name: "調査",
    description: "",
    systemPrompt: "",
    prompts: [
      { id: "p1", kind: "custom", label: "ラベル 1", prompt: "本文 1" },
      { id: "p2", kind: "builtin", label: "ラベル 2", prompt: "本文 2" },
    ],
  };
  assert.deepEqual(promptSelectionOf(agent), ["p1", "p2"]);
  assert.deepEqual(promptSelectionOf(undefined), []);
});

test("削除の確認は対象のラベルを示し、取り消せないことを本文で伝える", () => {
  const request = promptDeleteConfirmRequest("ラベル");
  assert.equal(request.title, "定型プロンプトを削除");
  assert.deepEqual(request.subject, { label: "削除する定型プロンプト", value: "ラベル" });
  assert.equal(request.danger, true);
});

test("選択面は選択済みの順序・解除・追加を出し、上限では追加を止める", () => {
  const prompts = [prompt("p1", { label: "同じ" }), prompt("p2", { label: "同じ" }), prompt("p3")];
  const html = renderToStaticMarkup(
    createElement(PromptSelector, { prompts, promptIds: ["p2", "p1"], onChange: () => {} }),
  );
  // 同じラベルの別マスタでも、選択済みの 2 件を ID ごとに並べる
  assert.match(html, /p2|同じ/);
  assert.equal((html.match(/同じ/g) ?? []).length >= 2, true);
  assert.match(html, /2 \/ 6/);
  assert.match(html, /紐づけを解除/);
  assert.match(html, /を追加/);

  const full = Array.from({ length: AGENT_PROMPT_LIMIT }, (_, index) => prompt(`f${index}`));
  const limited = renderToStaticMarkup(
    createElement(PromptSelector, {
      prompts: [...full, prompt("extra")],
      promptIds: full.map((entry) => entry.id),
      onChange: () => {},
    }),
  );
  assert.match(limited, /追加できるのは 6 件までです/);
  // 上限では追加ボタンを押せない (見えない上限で理由も読めない、を避ける)
  assert.match(limited, /disabled=""/);
  assert.match(limited, /6 \/ 6/);
});
