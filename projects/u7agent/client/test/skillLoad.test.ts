// スキル読み込み行の整形と、ライブ / 履歴の 2 経路が同じ呼び出しを二重に出さないことの回帰テスト。
// [skill] 行の表記は pi ネイティブの formatReadLineRange() に合わせる (offset 省略は 1 行目、
// limit 省略は最終行まで)。
import assert from "node:assert/strict";
import test from "node:test";
import { chatReducer, historyToBubbles, initialChatState, type ToolCard } from "../src/hooks/chatReducer";
import { formatReadLineRange, skillLoadSummary, toolCallIdsOf, visibleSkillLoads } from "../src/lib/skillLoad";
import { abbreviatedToolSummary, historyPreview } from "../src/lib/toolSummary";
import type { SessionPayload, SkillLoad } from "../src/types";

const LOAD: SkillLoad = { id: "call-1", name: "gh", path: "/work/.agents/skills/gh/SKILL.md", offset: 5, limit: 3 };

function card(overrides: Partial<ToolCard> = {}): ToolCard {
  return { id: "call-1", name: "read", args: ".agents/skills/gh/SKILL.md", phase: "done", output: "", ...overrides };
}

function payload(messages: SessionPayload["messages"], run: SessionPayload["run"] = null): SessionPayload {
  return {
    sessionId: "s-1",
    piSessionId: "pi-s-1",
    cwd: "",
    eventGeneration: "gen-1",
    status: "completed",
    title: "",
    createdAt: 1,
    lastUsedAt: 1,
    queueDepth: 0,
    lastSeq: 3,
    run,
    messages,
    compactions: [],
  };
}

test("[skill] 行の行範囲は pi の formatReadLineRange() と同じ表記になる", () => {
  assert.equal(formatReadLineRange(), "");
  assert.equal(formatReadLineRange(5), ":5");
  assert.equal(formatReadLineRange(undefined, 10), ":1-10");
  assert.equal(formatReadLineRange(5, 10), ":5-14");
  assert.equal(skillLoadSummary({ name: "gh" }), "[skill] gh");
  assert.equal(skillLoadSummary(LOAD), "[skill] gh:5-7");
});

test("カード行とツール履歴サマリーは [skill] を同じ表記で出す", () => {
  assert.equal(abbreviatedToolSummary(card({ skill: LOAD })), "[skill] gh:5-7");
  assert.equal(historyPreview([card({ skill: LOAD })]), "[skill] gh:5-7", "1 件はカード行と同じ関数の結果");
  // 複数件は呼び出し順ではなくスキル発火を先頭に列挙する
  assert.equal(
    historyPreview([card({ id: "a", name: "bash", args: "ls" }), card({ id: "b", skill: LOAD })]),
    "[skill] gh:5-7 / bash",
  );
  // 通常のツールは従来どおり
  assert.equal(abbreviatedToolSummary(card()), "read — .agents/skills/gh/SKILL.md");
  assert.equal(historyPreview([card({ id: "a", name: "bash" }), card({ id: "b", name: "grep" })]), "bash / grep");
});

test("historyToBubbles は skillLoads をバブルへ写す", () => {
  const { bubbles } = historyToBubbles(1, [
    { role: "user", text: "読んで" },
    { role: "assistant", text: "読みました", skillLoads: [LOAD] },
  ]);

  assert.deepEqual(bubbles[0].skillLoads, []);
  assert.deepEqual(bubbles[1].skillLoads, [LOAD]);
});

test("resync で run のカードが最後のバブルへまとまっても導出行は二重にならない", () => {
  const toolCall = {
    id: LOAD.id,
    name: "read",
    args: LOAD.path,
    isError: false,
    done: true,
    output: "",
    skill: LOAD,
  };
  const resynced = chatReducer(initialChatState, {
    type: "resync",
    payload: payload(
      [
        { role: "user", text: "読んで" },
        { role: "assistant", text: "読みました", skillLoads: [LOAD] },
      ],
      { id: "run-1", status: "completed", startedAt: 1, endedAt: 2, prompt: "読んで", toolCalls: [toolCall] },
    ),
  });

  const last = resynced.bubbles.at(-1);
  assert.deepEqual(last?.tools[0]?.skill, LOAD, "resync のカードにも skill が載る");
  const toolCallIds = toolCallIdsOf(resynced.bubbles);
  assert.deepEqual(
    visibleSkillLoads(resynced.bubbles[1].skillLoads, toolCallIds),
    [],
    "カードと同じ呼び出しは出さない",
  );
  // 前の run の導出行 (カードが残っていない) は出したままにする
  const older: SkillLoad = { id: "call-old", name: "writer", path: "/work/writer/SKILL.md" };
  assert.deepEqual(visibleSkillLoads([older], toolCallIds), [older]);

  const ended = chatReducer(resynced, { type: "runEnd", status: "completed", queueDepth: 0 });
  assert.deepEqual(
    visibleSkillLoads(ended.bubbles[1].skillLoads, toolCallIdsOf(ended.bubbles)),
    [],
    "runEnd で toolBubbleIds を空にしても導出行は復活しない",
  );
});

test("toolStart は skill を ToolCard へ写す", () => {
  const started = chatReducer(initialChatState, {
    type: "toolStart",
    id: LOAD.id,
    name: "read",
    args: LOAD.path,
    skill: LOAD,
    at: 1,
  });

  assert.deepEqual(started.bubbles[0].tools[0].skill, LOAD);
  assert.equal(started.bubbles[0].skillLoads.length, 0);
});
