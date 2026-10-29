// 会話の分岐の純関数と API 契約。行メニューの項目・無効理由・要求・遷移の判定・分岐元 / 分岐先のリンクは
// 純関数で固定し、ダイアログの候補と既定は SSR で描画して検査する。

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { SessionForkDialog } from "../src/components/SessionForkDialog";
import {
  FORK_ORIGIN_DELETED_NOTE,
  forkAgentChoices,
  forkAgentId,
  forkBlockedReason,
  forkOpenDecision,
  forkRelations,
  forkRequest,
  sessionForkDialogText,
} from "../src/lib/sessionFork";
import { sessionRowActions } from "../src/lib/sidebarRowMenu";
import type { AgentDef, SessionSummary } from "../src/types";

globalThis.location ??= { origin: "http://localhost" } as Location;
const { createSpaceApi } = await import("../src/api");

const general: AgentDef = { id: "general", name: "汎用アシスタント", description: "", systemPrompt: "" };
const research: AgentDef = { ...general, id: "research", name: "調査" };

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "s-1",
    title: "会話",
    agentId: general.id,
    status: "idle",
    queueDepth: 0,
    pinned: false,
    messageCount: 2,
    createdAt: 0,
    lastUsedAt: 0,
    serveCommand: null,
    ...overrides,
  };
}

test("行メニューの分岐は受け取りがある行だけに出て、busy / 片付け中は理由付きで無効になる", () => {
  const idle = sessionRowActions({ canFork: true });
  const fork = idle.find((action) => action.kind === "fork");
  assert.equal(fork?.label, "会話を分岐");
  assert.equal(fork?.disabled, false, "idle では押せる");
  assert.ok(fork?.description?.includes("元の会話は残ります"), "何が起きるかを説明する");
  assert.equal(
    idle.some((action) => action.kind === "handoff"),
    false,
    "受け取りが無い操作は出さない",
  );

  // busy はサーバーの 409 と同じ条件 (実行中・キュー待ち・圧縮中) で無効にし、理由を説明行へ出す
  for (const blocked of [
    sessionRowActions({ canFork: true, forkBlockedReason: forkBlockedReason(summary({ status: "running" })) }),
    sessionRowActions({ canFork: true, forkBlockedReason: forkBlockedReason(summary({ queueDepth: 1 })) }),
    sessionRowActions({ canFork: true, forkBlockedReason: forkBlockedReason(summary({ handoffCleanup: true })) }),
  ]) {
    const action = blocked.find((item) => item.kind === "fork");
    assert.equal(action?.disabled, true);
    assert.ok((action?.description ?? "").length > 0);
  }
  assert.equal(forkBlockedReason(summary({ status: "completed" })), "", "終端は依頼中ではない");
  assert.equal(
    sessionRowActions().some((action) => action.kind === "fork"),
    false,
    "受け取りが無ければ出さない",
  );
});

test("分岐の要求は現在のエージェントを省略し、別のエージェントだけ id を送る", () => {
  const choices = forkAgentChoices([general, research], research.id, research.name);
  const current = choices.find((choice) => choice.current);
  assert.ok(current);
  assert.deepEqual(forkRequest(current), {});
  assert.equal(forkAgentId(current), undefined, "現在は保存済みのスナップショットを維持する");
  const other = choices.find((choice) => !choice.current);
  assert.ok(other);
  assert.deepEqual(forkRequest(other), { agentId: general.id });

  // カタログから消えたエージェントでも現在として先頭に残す
  const orphan = forkAgentChoices([general], "deleted-agent", "消えたエージェント");
  assert.deepEqual(orphan[0], { id: "deleted-agent", name: "消えたエージェント", current: true });
});

test("分岐の確認文言は残るものと共有するもの、引き継がないものを示す", () => {
  const text = sessionForkDialogText("決済画面の検証");
  assert.equal(text.title, "会話を分岐");
  assert.deepEqual(text.subject, { label: "分岐する会話", value: "決済画面の検証" });
  const body = text.body.join("\n");
  assert.ok(body.includes("元の会話はそのまま残ります"), "元の会話が残ることを示す");
  assert.ok(body.includes("作業フォルダ") && body.includes("共有"), "共有を示す");
  assert.ok(body.includes("未送信") && body.includes("引き継ぎません"), "引き継がないものを示す");
  assert.ok(text.agentNote.includes("役割・指示・ツール"), "別エージェントの注意を持つ");
  assert.equal(text.confirmLabel, "分岐する");
});

test("分岐元 / 分岐先は同じスペースの一覧から引き、親が消えていれば削除済みとして示す", () => {
  const sessions = [
    summary({ sessionId: "parent", title: "分岐元の会話" }),
    summary({ sessionId: "child", title: "分岐した会話", parentSessionId: "parent" }),
    summary({ sessionId: "other", title: "無関係" }),
  ];
  assert.deepEqual(forkRelations(sessions, sessions[0]), {
    children: [{ sessionId: "child", title: "分岐した会話" }],
  });
  assert.deepEqual(forkRelations(sessions, sessions[1]), {
    origin: { sessionId: "parent", title: "分岐元の会話" },
    children: [],
  });
  // 親が削除されていても子の関係は残り、分岐元は削除済みとして縮退する
  const orphaned = sessions.filter((item) => item.sessionId !== "parent");
  assert.deepEqual(forkRelations(orphaned, sessions[1]), { origin: "deleted", children: [] });
  assert.equal(FORK_ORIGIN_DELETED_NOTE, "分岐元の会話は削除されています");
  assert.deepEqual(forkRelations(sessions, summary({ sessionId: "other" })), { children: [] });
});

test("分岐の応答は、要求後に利用者が別の会話を選んでいたら開かない", () => {
  assert.equal(forkOpenDecision(3, 3), "open");
  assert.equal(forkOpenDecision(3, 4), "keep", "遅れて届いた応答で選択を巻き戻さない");
});

test("分岐 API は要求元のスペースを query に、エージェントだけを body に送る", async (t) => {
  const api = createSpaceApi("space-a");
  const result = { sessionId: "child", parentSessionId: "session-a" };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(request.method, "POST");
    assert.equal(url.pathname, "/api/sessions/session-a/fork");
    assert.equal(url.searchParams.get("spaceId"), "space-a");
    assert.deepEqual(await request.json(), { agentId: "research" });
    return Response.json(result, { status: 201 });
  });
  assert.deepEqual(await api.forkSession("session-a", { agentId: "research" }), result);
});

test("分岐 API の失敗はサーバーの理由と HTTP status を保つ", async (t) => {
  const api = createSpaceApi("space-a");
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "実行中・キュー中・圧縮中・設定変更中のセッションは分岐できません" }, { status: 409 }),
  );
  await assert.rejects(api.forkSession("session-a", {}), {
    message: "実行中・キュー中・圧縮中・設定変更中のセッションは分岐できません",
    status: 409,
  });
});

function render(overrides: Partial<Parameters<typeof SessionForkDialog>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(SessionForkDialog, {
      text: sessionForkDialogText("決済画面の検証"),
      agents: forkAgentChoices([general, research], general.id, general.name),
      blockedNote: "",
      onClose: () => {},
      onFork: async () => {},
      ...overrides,
    }),
  );
}

/** 確定ボタン。取り消しと区別するため submit で引く */
function submitButton(html: string): string {
  const match = /<button[^>]*type="submit"[^>]*>/.exec(html);
  assert.ok(match, "確定ボタンが無い");
  return match[0];
}

test("分岐ダイアログは現在のエージェントを既定にし、現在のままなら注意を出さない", () => {
  const html = render();
  assert.ok(html.includes('aria-label="会話を分岐"'), "見出しが読み上げ名になっていない");
  assert.ok(html.includes("決済画面の検証"), "対象のタイトルが出ていない");
  assert.ok(html.includes("汎用アシスタント（現在）"), "現在のエージェントの印が無い");
  assert.ok(html.includes("調査"), "分岐先のエージェントが出ていない");
  assert.ok(html.includes("そのまま引き継ぎます"), "現在のままの説明が無い");
  assert.ok(html.includes("作業フォルダ") && html.includes("共有"), "共有の説明が無い");
  assert.ok(!submitButton(html).includes("disabled"), "既定で確定が無効になっている");
  assert.match(html, /<button[^>]*type="submit"[^>]*>分岐する<\/button>/, "確定の名前が違う");
});

test("分岐ダイアログは無効理由があると確定できず、その理由を出す", () => {
  const html = render({ blockedNote: "実行中・キュー待ち・圧縮中は引き継げません。" });
  assert.ok(submitButton(html).includes("disabled"), "無効理由があるのに押せる");
  assert.ok(html.includes("実行中・キュー待ち・圧縮中"), "無効理由が出ていない");
});
