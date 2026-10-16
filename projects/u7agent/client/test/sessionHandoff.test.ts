// 会話の引き継ぎ (エージェント / スペースの交代) の純関数。ダイアログの文言、無効理由、チップの
// 導出を固定する (描画は sessionHandoffDialog.test.ts、送信本文への合成は suggestion.test.ts)。

import assert from "node:assert/strict";
import test from "node:test";
import { suggestionSendText } from "../src/lib/suggestion";
import {
  HANDOFF_CHIP_LABEL,
  HANDOFF_CHIP_PROMPT,
  HANDOFF_PROJECT_MEMO_NOTE,
  handoffAgentChoices,
  handoffAgentId,
  handoffBlockedReason,
  handoffMemoDisabledReason,
  handoffSuggestion,
  sessionHandoffDialogText,
} from "../src/lib/sessionHandoff";

test("引き継ぎの確認は履歴の破棄・ファイルの保持・スペース切替を伝え、対象のタイトルを独立した行に出す", () => {
  const text = sessionHandoffDialogText("決済画面の検証");
  assert.equal(text.title, "会話を引き継ぐ");
  assert.deepEqual(text.subject, { label: "引き継ぐ会話", value: "決済画面の検証" });
  assert.equal(text.confirmLabel, "引き継ぐ");
  assert.ok(
    text.body.some((line) => line.includes("履歴") && line.includes("破棄")),
    "履歴の破棄が本文に無い",
  );
  assert.ok(
    text.body.some((line) => line.includes("作業フォルダ") && line.includes("残り")),
    "ファイルの保持が本文に無い",
  );
  assert.ok(
    text.body.some((line) => line.includes("切り替わ")),
    "スペース切替の予告が本文に無い",
  );
  assert.ok(text.memoDescription.includes("HANDOFF.md"), "メモの説明が無い");
  assert.ok(HANDOFF_PROJECT_MEMO_NOTE.includes("リポジトリ直下"), "プロジェクトの注意が無い");
  // 一覧が古くてタイトルが取れない行でも確認は出す (対象の行を省くだけ)
  assert.equal(sessionHandoffDialogText("").subject, undefined);
});

test("引き継ぎの無効理由とチップの導出は会話の状態から決まる", () => {
  const base = { sessionId: "s-1", title: "t", agentId: "a", status: "idle" as const, queueDepth: 0 };
  assert.equal(handoffBlockedReason(base), "");
  assert.ok(handoffBlockedReason({ ...base, status: "running" }).includes("実行中"));
  assert.ok(handoffBlockedReason({ ...base, status: "queued" }).includes("実行中"));
  assert.ok(handoffBlockedReason({ ...base, status: "compacting" }).includes("実行中"));
  assert.ok(handoffBlockedReason({ ...base, queueDepth: 2 }).includes("実行中"));
  assert.ok(handoffBlockedReason({ ...base, handoffCleanup: true }).includes("片付け"));
  // 終端は依頼中ではない (完了した会話を永久に押せなくしない)
  for (const status of ["completed", "stopped", "error"] as const) {
    assert.equal(handoffBlockedReason({ ...base, status }), "", `${status} で押せなくなっている`);
  }
  assert.equal(handoffMemoDisabledReason(2), "");
  assert.ok(handoffMemoDisabledReason(0).includes("メモにできる会話"));
});

test("引き継ぎのチップはメモありで未消費のときだけ出る", () => {
  const handoff = { operationId: "abc12345", at: 0, memo: true, consumed: false, cleanupPending: false };
  assert.deepEqual(handoffSuggestion(handoff), { label: HANDOFF_CHIP_LABEL, prompt: HANDOFF_CHIP_PROMPT });
  assert.equal(handoffSuggestion({ ...handoff, consumed: true }), null);
  assert.equal(handoffSuggestion({ ...handoff, memo: false }), null);
  assert.equal(handoffSuggestion(undefined), null);
  // 送信本文への合成は定型プロンプトと同じ経路 (チップの文と入力した文が一緒に届く)
  const chip = handoffSuggestion(handoff);
  assert.ok(chip);
  assert.equal(suggestionSendText(chip.prompt, ""), HANDOFF_CHIP_PROMPT);
  assert.equal(
    suggestionSendText(chip.prompt, " 追加の用事 "),
    `${HANDOFF_CHIP_PROMPT}\n\n追加の用事`,
    "チップの文と本文の合成順が違う",
  );
});

test("現在のエージェントがカタログから消えていても先頭に残し、その id は送らない", () => {
  const choices = handoffAgentChoices([], "deleted-agent", "消えたエージェント");
  assert.deepEqual(choices, [{ id: "deleted-agent", name: "消えたエージェント", current: true }]);
  assert.equal(handoffAgentId(choices[0]), undefined);
  const research = { id: "research", name: "調査", description: "", systemPrompt: "", skillIds: [] };
  const general = { id: "general", name: "汎用", description: "", systemPrompt: "", skillIds: [] };
  const withCurrent = handoffAgentChoices([general, research], "research", "調査");
  assert.deepEqual(withCurrent, [
    { id: "general", name: "汎用", current: false },
    { id: "research", name: "調査", current: true },
  ]);
  // 現在のエージェントは id を省略して送る (保存済みのスナップショットを維持する)
  assert.equal(handoffAgentId(withCurrent[1]), undefined);
  assert.equal(handoffAgentId(withCurrent[0]), "general");
});
