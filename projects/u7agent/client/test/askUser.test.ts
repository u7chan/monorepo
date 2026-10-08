// ask_user のカード: 入力の純関数 / reducer の状態遷移 / 本文を持たない assistant の resync 復帰 /
// Composer の送信ブロックの回帰テスト。正はサーバーの DTO (ToolCall.questions / answers)。
import assert from "node:assert/strict";
import test from "node:test";
import { chatReducer, historyToBubbles, initialChatState, type Bubble } from "../src/hooks/chatReducer";
import {
  askUserAnswerText,
  askUserAnswersClosing,
  askUserAnswersFromDrafts,
  askUserDraftAt,
  askUserDraftResolved,
  askUserDraftSelectedCount,
  askUserDraftsComplete,
  emptyAskUserDrafts,
  isPendingAskUser,
  nextUnresolvedAskUserIndex,
  pendingAskUserQuestionCount,
  toggleAskUserOption,
  type AskUserDraft,
} from "../src/lib/askUser";
import { deriveComposerSettings } from "../src/lib/composerSettings";
import { nonSkillToolCards } from "../src/lib/skillLoad";
import type { AskUserQuestion, HistoryPage, RunPayload, SessionPayload, ToolCall } from "../src/types";

const QUESTIONS: AskUserQuestion[] = [
  { question: "どちらで進めますか", header: "方式", options: [{ label: "A 案" }, { label: "B 案" }] },
  { question: "補足はありますか", type: "text" },
];

function askCall(id: string, done: boolean, answers?: ToolCall["answers"]): ToolCall {
  return {
    id,
    name: "ask_user",
    args: '{"questions":[…]}',
    isError: false,
    done,
    output: "",
    questions: QUESTIONS,
    ...(answers ? { answers } : {}),
  };
}

function run(toolCalls: ToolCall[], status: RunPayload["status"] = "running"): RunPayload {
  return { id: "run-1", status, startedAt: 1, prompt: "聞いて", toolCalls, totalRetryCount: 0 };
}

function payload(
  messages: SessionPayload["messages"],
  payloadRun: RunPayload | null = null,
  status: SessionPayload["status"] = "running",
): SessionPayload {
  return {
    sessionId: "s-1",
    piSessionId: "pi-s-1",
    cwd: "",
    eventGeneration: "gen-1",
    status,
    title: "",
    createdAt: 1,
    lastUsedAt: 1,
    serverNow: 1,
    queueDepth: 0,
    pinned: false,
    lastSeq: 3,
    run: payloadRun,
    messages,
    compactions: [],
  };
}

function assistantBubbles(bubbles: readonly Bubble[]): Bubble[] {
  return bubbles.filter((bubble) => bubble.role === "assistant");
}

/** 全履歴 API の最新ページ相当 (初回 F5 で legacy 表示の直後に届く形) */
function historyPage(items: HistoryPage["items"]): HistoryPage {
  const messages = items.filter((item) => item.kind === "message");
  return {
    sessionId: "s-1",
    items,
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: messages.find((item) => item.context === "active")?.id ?? null,
    messageCount: messages.length,
    summarizedMessageCount: 0,
  };
}

function userItem(id: string, text: string): HistoryPage["items"][number] {
  return { kind: "message", id, context: "active", role: "user", text };
}

function askCards(bubbles: readonly Bubble[]) {
  return assistantBubbles(bubbles).flatMap((bubble) => bubble.tools.filter((card) => card.questions?.length));
}

test("入力の純関数は全質問が埋まるまで送信不可にする", () => {
  const drafts = emptyAskUserDrafts(QUESTIONS);
  // assert.deepEqual は asserts 契約なので、期待値を型注釈して drafts を狭めない (selected: never[] への収束を防ぐ)
  const empty: AskUserDraft = { selected: [], text: "", skipped: false };
  assert.deepEqual(drafts, [empty, empty]);
  assert.equal(askUserDraftsComplete(drafts), false, "空は不可");

  const selected = [...drafts];
  selected[0] = toggleAskUserOption(selected[0], "A 案", false);
  assert.equal(askUserDraftsComplete(selected), false, "片方だけでは不可");
  assert.deepEqual(askUserAnswersFromDrafts(selected)[0], { index: 0, selected: ["A 案"] }, "index は質問の並びで振る");

  // 単一選択はトグルで 1 つだけ残し、複数選択は積む
  assert.deepEqual(toggleAskUserOption(selected[0], "B 案", false).selected, ["B 案"]);
  assert.deepEqual(toggleAskUserOption(selected[0], "A 案", false).selected, []);
  assert.deepEqual(toggleAskUserOption(selected[0], "B 案", true).selected, ["A 案", "B 案"]);

  const withText = [...drafts];
  withText[1] = { selected: [], text: " 補足 ", skipped: false };
  assert.equal(askUserDraftsComplete(withText), false, "1 問目が未回答");
  withText[0] = toggleAskUserOption(withText[0], "A 案", false);
  assert.equal(askUserDraftsComplete(withText), true);
  assert.deepEqual(askUserAnswersFromDrafts(withText), [
    { index: 0, selected: ["A 案"] },
    { index: 1, text: "補足" },
  ]);

  // 「回答しない」は入力済みとして扱い、選択と自由記入は送らない
  const skipped: AskUserDraft[] = [
    { selected: [], text: "", skipped: true },
    { selected: ["B 案"], text: "メモ", skipped: false },
  ];
  assert.equal(askUserDraftsComplete(skipped), true);
  assert.deepEqual(askUserAnswersFromDrafts(skipped), [
    { index: 0, skipped: true },
    { index: 1, selected: ["B 案"], text: "メモ" },
  ]);
});

test("回答待ちは実行中の run のカードだけを数え、質問数で送信をブロックする", () => {
  const waiting = askCall("call-1", false);
  assert.equal(isPendingAskUser(waiting), true);
  assert.equal(pendingAskUserQuestionCount({ "call-1": waiting }, "running"), QUESTIONS.length);
  assert.equal(pendingAskUserQuestionCount({ "call-1": waiting }, "idle"), 0, "run 終了後は回答できない");
  assert.equal(pendingAskUserQuestionCount({ "call-1": askCall("call-1", false, []) }, "running"), 0, "回答済み");
  assert.equal(pendingAskUserQuestionCount({ "call-1": askCall("call-1", true) }, "running"), 0, "完了済み");
  assert.equal(pendingAskUserQuestionCount({}, "running"), 0);

  const settings = deriveComposerSettings({
    health: null,
    selectedAgent: undefined,
    sessionId: "s-1",
    preselection: {},
    chat: {
      sessionModel: "stub/model",
      sessionThinkingLevel: "low",
      supportsThinking: true,
      availableThinkingLevels: ["off", "low"],
      runStatus: "running",
      runTools: { "call-1": waiting },
    },
    sending: false,
    settingsChanging: false,
    stopVisible: false,
  });
  assert.equal(settings.sendBlockedReason, "上の質問に回答してください（2件）");
});

test("toolStart / toolEnd / runEnd でカードの質問と回答が揃う", () => {
  const started = chatReducer(initialChatState, { type: "resync", payload: payload([], run([], "queued"), "queued") });
  const asked = chatReducer(started, {
    type: "toolStart",
    id: "call-1",
    name: "ask_user",
    args: '{"questions":[…]}',
    questions: QUESTIONS,
    at: 2,
  });
  assert.deepEqual(askCards(asked.bubbles)[0]?.questions, QUESTIONS);
  assert.equal(askCards(asked.bubbles)[0]?.phase, "running");
  assert.equal(isPendingAskUser(asked.runTools["call-1"]), true);
  assert.deepEqual(nonSkillToolCards(asked.bubbles[1]?.tools ?? []), [], "専用カードは汎用ツール履歴に出さない");

  const failed = chatReducer(asked, {
    type: "toolEnd",
    id: "call-1",
    isError: true,
    output: "回答が得られないまま停止しました",
  });
  assert.equal(askCards(failed.bubbles)[0]?.phase, "failed");
  assert.deepEqual(
    failed.runTools["call-1"]?.answers,
    undefined,
    "回答が無ければ待機のまま扱わない (phase で判定する)",
  );
  assert.equal(pendingAskUserQuestionCount(failed.runTools, "running"), 0, "完了したカードは数えない");

  const answered = chatReducer(asked, {
    type: "toolEnd",
    id: "call-1",
    isError: false,
    output: "ユーザーの回答:",
    answers: [
      { index: 0, selected: ["A 案"] },
      { index: 1, skipped: true },
    ],
  });
  assert.deepEqual(askCards(answered.bubbles)[0]?.answers, [
    { index: 0, selected: ["A 案"] },
    { index: 1, skipped: true },
  ]);
  assert.deepEqual(answered.runTools["call-1"]?.answers?.length, 2);
  assert.equal(pendingAskUserQuestionCount(answered.runTools, "running"), 0);

  const ended = chatReducer(answered, { type: "runEnd", runId: "run-1", status: "completed", queueDepth: 0 });
  assert.equal(askCards(ended.bubbles).length, 1, "runEnd でも記録として残す");
});

test("本文を持たない assistant の ask_user は resync でカードごと復帰する", () => {
  // 履歴側に assistant の本文が無い (tool call だけ) ため、resync で補完先が失われる状態を作る
  const resynced = chatReducer(initialChatState, {
    type: "resync",
    payload: payload([{ role: "user", text: "聞いて" }], run([askCall("call-1", false)]), "running"),
  });
  const cards = askCards(resynced.bubbles);
  assert.equal(cards.length, 1, "合成した assistant バブルへカードを補完する");
  assert.deepEqual(cards[0]?.questions, QUESTIONS);
  assert.equal(assistantBubbles(resynced.bubbles).length, 1);
  assert.equal(resynced.bubbles[1]?.entryId, undefined, "合成したバブルはライブ扱い (entryId を持たない)");

  // 回答済みは合成しない (本文を持たない assistant のカードは履歴に出ない既知の制限を広げない)
  const answered = chatReducer(initialChatState, {
    type: "resync",
    payload: payload([{ role: "user", text: "聞いて" }], run([askCall("call-1", true, [])], "stopped"), "stopped"),
  });
  assert.deepEqual(assistantBubbles(answered.bubbles), []);

  // 合成したバブルは次の resync でも作り直され、カードが消えない (F5 / SSE 再接続の復帰)
  const again = chatReducer(resynced, {
    type: "resync",
    payload: payload([{ role: "user", text: "聞いて" }], run([askCall("call-1", false)]), "running"),
  });
  assert.equal(askCards(again.bubbles).length, 1);
  assert.equal(pendingAskUserQuestionCount(again.runTools, again.runStatus), QUESTIONS.length);
});

test("履歴ページが届いても回答待ちカードは末尾に残り、空の assistant を足さない", () => {
  // 初回 resync (payload.messages) → 最新履歴ページの順。本文を持たない assistant は履歴 item に
  // 現れないため、突き合わせが効かずページ先頭へ繰り上がるとカードが画面外に消える (F5 の経路)
  const initial = chatReducer(initialChatState, {
    type: "resync",
    payload: payload([{ role: "user", text: "聞いて" }], run([askCall("call-1", false)]), "running"),
  });
  assert.deepEqual(
    initial.bubbles.map((bubble) => bubble.role),
    ["user", "assistant"],
    "legacy 表示は user の後ろに合成バブルを置く",
  );

  const merged = chatReducer(initial, { type: "resyncHistory", page: historyPage([userItem("m1", "聞いて")]) });
  assert.deepEqual(
    merged.bubbles.map((bubble) => bubble.role),
    ["user", "assistant"],
    "カードのバブルは履歴の後ろに残る (先頭へ繰り上げない)",
  );
  assert.deepEqual(
    merged.bubbles.map((bubble) => bubble.entryId),
    ["m1", undefined],
    "履歴側だけ entryId を持つ",
  );
  assert.equal(askCards(merged.bubbles).length, 1);
  assert.equal(assistantBubbles(merged.bubbles).length, 1, "空の assistant を足さない");
  assert.equal(merged.bubbles[1]?.tools[0]?.id, "call-1");
  assert.equal(pendingAskUserQuestionCount(merged.runTools, merged.runStatus), QUESTIONS.length);

  // 続けて届いた resync でも同じ位置を保つ (回答待ちの間は次のイベントが来ない)
  const again = chatReducer(merged, {
    type: "resync",
    payload: payload([{ role: "user", text: "聞いて" }], run([askCall("call-1", false)]), "running"),
  });
  assert.equal(askCards(again.bubbles).length, 1, "resync でカードが二重にならない");
  assert.equal(assistantBubbles(again.bubbles).length, 1);
});

test("履歴のカードも質問と回答を写して専用カードに出せる", () => {
  const { bubbles } = historyToBubbles(1, [
    { role: "user", text: "聞いて" },
    {
      role: "assistant",
      text: "確認します",
      tools: [
        askCall("call-1", true, [
          { index: 0, selected: ["B 案"] },
          { index: 1, text: "補足" },
        ]),
        { id: "call-2", name: "bash", args: "$ ls", isError: false, done: true, output: "ok" },
      ],
    },
  ]);
  const cards = bubbles[1]?.tools ?? [];
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0]?.questions, QUESTIONS);
  assert.deepEqual(cards[0]?.answers, [
    { index: 0, selected: ["B 案"] },
    { index: 1, text: "補足" },
  ]);
  assert.deepEqual(
    nonSkillToolCards(cards).map((card) => card.id),
    ["call-2"],
    "専用カードを外しても汎用ツール履歴は残る (#N の対応を保つ)",
  );
});

test("1 問ずつ出すカードの判定は質問ごとの入力から導出する", () => {
  const drafts: AskUserDraft[] = [
    { selected: ["A 案", "B 案"], text: "メモ", skipped: false },
    { selected: [], text: "  ", skipped: false },
    { selected: [], text: "", skipped: true },
  ];
  // 空白だけの自由記入は未入力として扱い、選択と自由記入はどちらも 1 件として数える
  assert.deepEqual(drafts.map(askUserDraftSelectedCount), [3, 0, 0]);
  assert.deepEqual(drafts.map(askUserDraftResolved), [true, false, true]);
  assert.equal(askUserDraftResolved({ selected: [], text: " 補足 ", skipped: false }), true);
  assert.equal(askUserDraftsComplete(drafts), false);

  // 未回答の質問は「いまの後ろ → 先頭」の順で探し、無ければ undefined
  assert.equal(nextUnresolvedAskUserIndex(drafts, 0), 1);
  assert.equal(nextUnresolvedAskUserIndex(drafts, 2), 1, "末尾から先頭へ回る");
  assert.equal(nextUnresolvedAskUserIndex([drafts[0]!, drafts[2]!], 1), undefined, "全部回答済み");
  assert.equal(nextUnresolvedAskUserIndex([], 0), undefined, "質問が無い");

  // 閉じるときは回答済みを残し、未回答だけ「回答しない」にして送る (入力を捨てない)
  assert.deepEqual(askUserAnswersClosing(drafts), [
    { index: 0, selected: ["A 案", "B 案"], text: "メモ" },
    { index: 1, skipped: true },
    { index: 2, skipped: true },
  ]);

  // 記録の 1 行は選択と自由記入を並べ、回答なしは undefined (表示側で「回答なし」を出す)
  assert.equal(askUserAnswerText({ index: 0, selected: ["A 案", "B 案"], text: "メモ" }), "A 案、B 案、メモ");
  assert.equal(askUserAnswerText({ index: 1, text: "補足" }), "補足");
  assert.equal(askUserAnswerText({ index: 2, skipped: true }), undefined);
  assert.equal(askUserAnswerText(undefined), undefined);
  assert.equal(askUserAnswerText({ index: 3 }), undefined, "空の回答は回答なし");

  assert.deepEqual(askUserDraftAt(drafts, 9), { selected: [], text: "", skipped: false }, "範囲外は空の入力");
});
