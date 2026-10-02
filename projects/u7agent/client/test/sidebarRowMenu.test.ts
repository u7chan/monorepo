import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ProjectRow } from "../src/components/sidebar/ProjectRow";
import { SessionRow } from "../src/components/sidebar/SessionRow";
import { projectRowActions, sessionRenamePrompt, sessionRowActions } from "../src/lib/sidebarRowMenu";
import type { Project, SessionSummary } from "../src/types";

const project: Project = { id: "p-1", name: "hello", cwd: "work/hello", createdAt: 0 };

function renderProjectRow(): string {
  return renderToStaticMarkup(
    createElement(ProjectRow, {
      project,
      sessions: [],
      agents: [],
      sessionId: "",
      open: false,
      onToggle: () => {},
      onNewChat: () => {},
      onDelete: () => {},
      onSelectSession: () => {},
      onRenameSession: () => {},
      onDeleteSession: () => {},
    }),
  );
}

function renderSessionRow(overrides: Partial<SessionSummary> = {}): string {
  const item: SessionSummary = {
    sessionId: "s-1",
    title: "テスト",
    agentId: "agent-general",
    agentName: "汎用アシスタント",
    status: "idle",
    queueDepth: 0,
    messageCount: 2,
    createdAt: 0,
    lastUsedAt: 0,
    ...overrides,
  };
  return renderToStaticMarkup(
    createElement(SessionRow, {
      item,
      agents: [],
      active: false,
      onSelect: () => {},
      onRename: () => {},
      onDelete: () => {},
    }),
  );
}

/** ⋯ の button。行の選択 button とは aria-haspopup で区別する */
function menuTrigger(html: string): string {
  const match = /<button[^>]*aria-haspopup="menu"[^>]*>/.exec(html);
  assert.ok(match, "⋯ の button が無い");
  return match[0];
}

test("出し分け: プロジェクト行は 新しい会話 → 削除、セッション行は 名前を変更 → 削除 を返す", () => {
  assert.deepEqual(projectRowActions(), [
    { kind: "new-chat", label: "このプロジェクトに新しい会話" },
    { kind: "delete", label: "プロジェクトを削除", danger: true },
  ]);
  assert.deepEqual(sessionRowActions(), [
    { kind: "rename", label: "名前を変更" },
    { kind: "delete", label: "セッションを削除", danger: true },
  ]);
  assert.equal(sessionRenamePrompt(), "セッションの新しい名前を入力してください。");
});

test("プロジェクト行の操作は読み上げ名と 2 項目の並びを持つ", () => {
  const html = renderProjectRow();
  const trigger = menuTrigger(html);
  assert.ok(trigger.includes('aria-haspopup="menu"'), "⋯ が aria-haspopup を持たない");
  assert.ok(trigger.includes('aria-expanded="false"'), "⋯ が aria-expanded を持たない");
  assert.ok(trigger.includes('aria-label="hello の操作"'), "⋯ の読み上げ名に行の名前が入っていない");

  const items = html.split("<button").filter((part) => part.includes('role="menuitem"'));
  assert.equal(items.length, 2, "項目数が違う");
  const newChat = html.indexOf("このプロジェクトに新しい会話");
  const remove = html.indexOf("プロジェクトを削除");
  assert.ok(newChat >= 0 && newChat < remove, "並びが 新しい会話 → 削除 でない");

  // chevron は消した (折りたたみは行のクリック 1 つ。行の button が aria-expanded を持つ)
  assert.ok(!html.includes('aria-label="展開する"'), "折りたたみの chevron が残っている");
  assert.ok(html.includes('aria-expanded="false"'), "行の button が aria-expanded を持たない");
});

test("セッション行の ⋯ は 名前を変更 → 削除 の 2 項目で、通知のベルは行に残る", () => {
  const html = renderSessionRow();
  const trigger = menuTrigger(html);
  assert.ok(trigger.includes('aria-label="テスト の操作"'), "⋯ の読み上げ名にセッション名が入っていない");

  const items = html.split("<button").filter((part) => part.includes('role="menuitem"'));
  assert.equal(items.length, 2, "項目数が違う");
  const rename = html.indexOf("名前を変更");
  const remove = html.indexOf("セッションを削除");
  assert.ok(rename >= 0 && rename < remove, "並びが 名前を変更 → 削除 でない");

  assert.ok(!html.includes("×"), "× が残っている");

  // 通知のベルは状態の印なので行に残す (メニューへ移さない)。タイトルの無い行も読み上げ名が空にならない
  const withBell = renderSessionRow({ notify: true });
  assert.ok(withBell.includes('aria-label="通知オン"'), "通知のベルが行に残っていない");
  assert.ok(menuTrigger(withBell).includes('aria-label="テスト の操作"'));
  assert.ok(menuTrigger(renderSessionRow({ title: "" })).includes('aria-label="無題のセッション の操作"'));
});

test("圧縮中のセッションは実行中と区別できるラベルを出す", () => {
  const html = renderSessionRow({ status: "compacting" });

  assert.ok(html.includes("圧縮中"), "状態ラベルが無い");
  assert.ok(!html.includes("実行中"), "実行中のラベルを出している");
});

test("実行中とキュー待ちは実行中のラベルを表示し、待機件数は行に出さない", () => {
  for (const status of ["running", "queued"] as const) {
    const html = renderSessionRow({ status, queueDepth: 3, notify: true });
    assert.match(html, /title="実行中"[^>]*>実行中<\/span>/);
    assert.ok(html.includes("汎用アシスタント"));
    assert.ok(html.includes('aria-label="通知オン"'));
    assert.ok(!html.includes("キュー待ち"), `${status}: queued を独立したラベルにしている`);
    assert.ok(!html.includes("待機"), `${status}: 待機件数が行に残っている`);
  }
});

test("終端と idle の行は実行状態のラベルも title も出さない", () => {
  for (const status of ["completed", "stopped", "error", "idle"] as const) {
    const html = renderSessionRow({ status });
    assert.ok(!html.includes("実行中"), `${status}: 実行中が出ている`);
    assert.ok(!html.includes("圧縮中"), `${status}: 圧縮中が出ている`);
    assert.ok(
      !html.includes('title="実行中"') && !html.includes('title="圧縮中"'),
      `${status}: 状態の title が残っている`,
    );

    assert.ok(html.includes("汎用アシスタント"), `${status}: エージェント名まで消えている`);
  }
});
