// スキル読み込みバッジの整形・状態・ライブ / 履歴 / resync の統合と、ツール履歴からの除外の回帰テスト。
// バッジの表記は pi ネイティブの formatReadLineRange() に合わせる (offset 省略は 1 行目、
// limit 省略は最終行まで)。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillLoadList } from "../src/components/chat/SkillLoadList";
import { chatReducer, historyToBubbles, initialChatState, type Bubble, type ToolCard } from "../src/hooks/chatReducer";
import { toolHistoryCopyText } from "../src/lib/copy-content";
import {
  formatReadLineRange,
  nonSkillToolCards,
  skillBadgesOf,
  skillLoadSummary,
  type SkillBadge,
} from "../src/lib/skillLoad";
import { abbreviatedToolSummary, historyPreview } from "../src/lib/toolSummary";
import type { SessionPayload, SkillLoad, ToolCall } from "../src/types";

const LOAD: SkillLoad = { id: "call-1", name: "gh", path: "/work/.agents/skills/gh/SKILL.md", offset: 5, limit: 3 };

function card(overrides: Partial<ToolCard> = {}): ToolCard {
  return { id: "call-1", name: "read", args: ".agents/skills/gh/SKILL.md", phase: "done", output: "", ...overrides };
}

function skillCard(overrides: Partial<ToolCard> = {}): ToolCard {
  return card({ skill: LOAD, ...overrides });
}

/** 全バブル分を 1 本に集める (二重表示の検出は件数で見る) */
function allBadges(bubbles: readonly Bubble[]): SkillBadge[] {
  return [...skillBadgesOf(bubbles).values()].flat();
}

function payload(
  messages: SessionPayload["messages"],
  run: SessionPayload["run"] = null,
  status: SessionPayload["status"] = "completed",
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
    queueDepth: 0,
    lastSeq: 3,
    run,
    messages,
    compactions: [],
  };
}

test("[skill] バッジの行範囲は pi の formatReadLineRange() と同じ表記になる", () => {
  assert.equal(formatReadLineRange(), "");
  assert.equal(formatReadLineRange(5), ":5");
  assert.equal(formatReadLineRange(undefined, 10), ":1-10");
  assert.equal(formatReadLineRange(5, 10), ":5-14");
  assert.equal(skillLoadSummary({ name: "gh" }), "[skill] gh");
  assert.equal(skillLoadSummary(LOAD), "[skill] gh:5-7");
});

test("ツール履歴の件数・サマリー・コピー本文にスキル読み込みは入らない", () => {
  const cards = [card({ id: "call-2", name: "bash", args: "ls -la" }), skillCard()];
  const tools = nonSkillToolCards(cards);

  assert.deepEqual(
    tools.map((tool) => tool.id),
    ["call-2"],
    "スキル読み込みのカードを外す",
  );
  assert.equal(abbreviatedToolSummary(tools[0]), "bash — ls -la");
  assert.equal(historyPreview(tools), "bash — ls -la");
  // #N は UI の行番号と一致し続ける (両方とも nonSkillToolCards() を通した列から作る)
  assert.equal(toolHistoryCopyText(tools), "#1 tool: bash\nargs: ls -la");
  assert.deepEqual(nonSkillToolCards([skillCard()]), [], "スキルしか無いバブルはツール履歴を持たない");
  // スキル以外のサマリーは従来どおり
  assert.equal(historyPreview([card({ id: "a", name: "bash" }), card({ id: "b", name: "grep" })]), "bash / grep");
});

test("ライブ: toolStart の skill はバッジになり、toolEnd で成功 / 失敗が確定する", () => {
  const started = chatReducer(initialChatState, {
    type: "toolStart",
    id: LOAD.id,
    name: "read",
    args: LOAD.path,
    skill: LOAD,
    at: 1,
  });
  const running = allBadges(started.bubbles);
  assert.equal(running.length, 1);
  assert.equal(running[0].state, "running", "実行中は成功 / 失敗のどちらでもない");
  assert.equal(running[0].reason, undefined);

  const failed = chatReducer(started, {
    type: "toolEnd",
    id: LOAD.id,
    isError: true,
    output: "ENOENT: no such file or directory, open '/work/secret/SKILL.md'\n  at read (line 2)",
  });
  const failedBadges = allBadges(failed.bubbles);
  assert.equal(failedBadges.length, 1, "同じ呼び出しが二重にならない");
  assert.equal(failedBadges[0].state, "failed");
  assert.equal(
    failedBadges[0].reason,
    "ENOENT: no such file or directory, open '/work/secret/SKILL.md'",
    "理由は先頭の非空行だけ",
  );

  const done = chatReducer(started, { type: "toolEnd", id: LOAD.id, isError: false, output: "# gh" });
  assert.equal(allBadges(done.bubbles)[0].state, "done");
});

test("履歴: skillLoads はそのバブルにバッジとして出る (カードが無くても)", () => {
  const { bubbles } = historyToBubbles(1, [
    { role: "user", text: "読んで" },
    {
      role: "assistant",
      text: "読みました",
      skillLoads: [LOAD, { ...LOAD, id: "call-2", name: "secret", isError: true }],
    },
  ]);

  const badges = skillBadgesOf(bubbles);
  assert.deepEqual(badges.get(1), [], "user バブルには出さない");
  assert.equal(badges.get(2)?.length, 2);
  assert.equal(badges.get(2)?.[0].state, "done", "isError 省略はロード扱い");
  assert.equal(badges.get(2)?.[1].state, "failed");
  assert.equal(badges.get(2)?.[1].reason, undefined, "履歴だけの失敗は理由を持たない (表示側が「読み込み失敗」を出す)");
});

test("resync: 情報源が別バブルに分かれても同じ toolCallId は 1 回だけ出る", () => {
  // 履歴側 (bubble 2) は完了済み、カード側 (bubble 3) は実行中のまま resync された状態を作る
  const toolCall: ToolCall = {
    id: LOAD.id,
    name: "read",
    args: LOAD.path,
    isError: false,
    done: true,
    output: "",
    skill: LOAD,
  };
  const liveCall: ToolCall = {
    id: "call-9",
    name: "read",
    args: "/work/live/SKILL.md",
    isError: false,
    done: false,
    output: "",
    skill: { id: "call-9", name: "live", path: "/work/live/SKILL.md" },
  };
  const resynced = chatReducer(initialChatState, {
    type: "resync",
    payload: payload(
      [
        { role: "user", text: "読んで" },
        { role: "assistant", text: "読みました", skillLoads: [LOAD] },
        { role: "assistant", text: "続けます" },
      ],
      {
        id: "run-1",
        status: "running",
        startedAt: 1,
        endedAt: 2,
        prompt: "読んで",
        toolCalls: [toolCall, liveCall],
      },
      "running",
    ),
  });

  const badges = skillBadgesOf(resynced.bubbles);
  assert.equal(badges.get(2)?.length, 1, "履歴にある分は履歴側のバブルが表示位置");
  assert.equal(badges.get(2)?.[0].load.id, LOAD.id);
  assert.deepEqual(
    badges.get(3)?.map((badge) => badge.load.id),
    ["call-9"],
    "履歴に無いライブ分だけをカードのあるバブルへ出す",
  );
  assert.equal(badges.get(3)?.[0].state, "running");
  assert.equal(allBadges(resynced.bubbles).length, 2, "同じ呼び出しがカードと履歴で二重にならない");

  const ended = chatReducer(resynced, { type: "runEnd", status: "completed", queueDepth: 0 });
  assert.equal(allBadges(ended.bubbles).length, 2, "runEnd でカードが残っても履歴側と重複しない");
});

/* ===== 描画 (react-dom/server) ===== */

function renderBadges(badges: SkillBadge[]): string {
  return renderToStaticMarkup(createElement(SkillLoadList, { badges, compact: false }));
}

/** 履歴 1 件だけのバブルからバッジを作る (ライブ分はカードを渡す) */
function badgesOf(loads: SkillLoad[], cards: ToolCard[] = []): SkillBadge[] {
  return allBadges([{ id: 1, role: "assistant", text: "", tools: cards, skillLoads: loads }]);
}

test("描画: バッジは名前と行範囲を出し、展開にパスと行範囲・失敗理由を入れる", () => {
  const done = renderBadges(badgesOf([LOAD]));
  assert.ok(done.includes("[skill] gh:5-7"));
  assert.ok(done.includes(LOAD.path));
  assert.ok(done.includes(">5-7<"), "行範囲は : を除いて出す");
  assert.ok(!done.includes("読み込み失敗"));
  assert.ok(!done.includes("# gh skill"), "本文は出さない");

  const failed = renderBadges(
    badgesOf(
      [],
      [skillCard({ phase: "failed", output: "ENOENT: no such file or directory, open /work/secret/SKILL.md" })],
    ),
  );
  assert.ok(failed.includes("[skill] gh:5-7"), "失敗しても名前は常に出す");
  assert.ok(failed.includes("失敗理由"));
  assert.ok(failed.includes("ENOENT: no such file or directory, open /work/secret/SKILL.md"));
  assert.ok(failed.includes("text-danger-text"), "失敗は色で区別する");

  const running = renderBadges(badgesOf([], [skillCard({ phase: "running" })]));
  assert.ok(running.includes("読み込み中…"));
  assert.ok(running.includes("text-accent-text"), "実行中は成功 / 失敗どちらでもない色にする");

  assert.equal(renderBadges([]), "", "0 件なら何も出さない");
});

test("描画: 4 件以上は 3 件 + N に畳み、+N の中に残りを入れる", () => {
  const loads = Array.from({ length: 4 }, (_, index) => ({ ...LOAD, id: `call-${index + 1}`, name: `s${index + 1}` }));
  assert.ok(!renderBadges(badgesOf(loads.slice(0, 3))).includes("+1</span>"), "3 件までは畳まない");

  const html = renderBadges(badgesOf(loads));
  const foldAt = html.indexOf("+1</span>");
  assert.ok(foldAt > 0, "+1 が出ていない");
  assert.deepEqual(
    html.slice(0, foldAt).match(/\[skill\] s\d/g) ?? [],
    ["[skill] s1", "[skill] s2", "[skill] s3"],
    "表には 3 件だけ並べる",
  );
  assert.ok(html.indexOf("[skill] s4") > foldAt, "4 件目は +1 の中に入れる");
});

/* ===== MessageView (スキルしかないバブルでツール履歴を出さない) ===== */

// MessageView は api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { MessageView } = await import("../src/components/chat/MessageView");

function renderMessage(bubble: Bubble): string {
  return renderToStaticMarkup(
    createElement(MessageView, {
      bubble,
      skillBadges: skillBadgesOf([bubble]).get(bubble.id) ?? [],
      copied: false,
      compact: false,
      rootCwd: "",
      onCopy: () => {},
      copiedId: "",
      onCopyTool: () => {},
      copiedAll: false,
      onCopyAll: () => {},
    }),
  );
}

test("描画: スキルしかないバブルはツール履歴ブロックを出さない", () => {
  const html = renderMessage({
    id: 1,
    role: "assistant",
    text: "読みました",
    tools: [skillCard()],
    skillLoads: [],
  });
  assert.ok(!html.includes("ツール履歴"), "ツール履歴が出ている");
  assert.ok(html.includes("[skill] gh:5-7"));
});

test("描画: ツール履歴の件数とサマリーにスキル読み込みは数えない", () => {
  const html = renderMessage({
    id: 1,
    role: "assistant",
    text: "やりました",
    tools: [skillCard(), card({ id: "call-2", name: "bash", args: "ls -la" })],
    skillLoads: [],
  });
  assert.ok(html.includes("ツール履歴"));
  assert.ok(html.includes(">1件<"), "スキル込みの 2 件になっている");
  assert.ok(html.includes("bash — ls -la"));
  assert.equal(html.match(/\[skill\] gh:5-7/g)?.length, 1, "バッジとツール履歴サマリーで二重に出ている");
});
