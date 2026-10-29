// 左バーの会話スペースのチップ。会話一覧の見出しに置かれ、設定 → 会話スペース への導線になる
// (押下後の遷移とトーンの見た目はブラウザの受入で確認する)。

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { Sidebar } from "../src/components/Sidebar";

function renderSidebar(spaceName: string, conversationOnly: boolean): string {
  return renderToStaticMarkup(
    createElement(Sidebar, {
      spaceName,
      conversationOnly,
      mode: "nav",
      onSelectMode: () => {},
      activeSettingsSection: "agents",
      notificationsFailed: false,
      sessions: [],
      sessionId: "",
      agents: [],
      projects: [],
      newChat: () => {},
      selectSession: () => {},
      renameSession: () => {},
      handoffSession: () => {},
      forkSession: () => {},
      deleteSession: () => {},
      deleteProject: () => {},
      togglePinned: () => {},
      onNewProject: () => {},
      onOpenSettingsSection: () => {},
    }),
  );
}

test("会話スペースのチップは名前と「会話スペース: <name>」の読み上げ名を出し、ヘッダーの旧表示を消す", () => {
  const html = renderSidebar("既定", false);
  assert.match(html, /<button[^>]*aria-label="会話スペース: 既定"/, "チップの読み上げ名が無い");
  assert.ok(html.includes('title="会話スペース: 既定"'), "title が読み上げ名と揃っていない");
  assert.ok(html.includes(">既定</span>"), "会話スペース名が出ていない");
  assert.ok(!html.includes(">スペース:"), "ヘッダーに旧表示が残っている");
  assert.ok(html.includes("sidebar-projects-content"), "既定スペースで Projects が出ていない");
});

test("追加スペースでも見出しは Chats / 未所属 のままで、Projects を出さない", () => {
  const html = renderSidebar("デモ", true);
  assert.ok(html.includes(">未所属</span>"), "未所属の見出しが共通になっていない");
  assert.ok(html.includes("未所属のセッションはありません"), "空一覧の文言が共通になっていない");
  assert.ok(html.includes('aria-label="会話スペース: デモ"'), "チップが現在の会話スペースを指していない");
  assert.ok(!html.includes("sidebar-projects-content"), "追加スペースに Projects が出ている");
});
