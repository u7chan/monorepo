// サイドバー下部のデプロイ済みビルド表示。client に DOM テスト基盤が無いため react-dom/server の
// 静的描画で、health が返したときだけコミットハッシュを出す契約を固定する
// (ローカル開発では COMMIT_HASH が無いので、値の無い行を出さないことを見る)。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { Sidebar } from "../src/components/Sidebar";

function renderSidebar(commitHash?: string): string {
  return renderToStaticMarkup(
    createElement(Sidebar, {
      mode: "nav",
      onSelectMode: () => {},
      activeSettingsSection: "runtime",
      notificationsFailed: false,
      onNewProject: () => {},
      onOpenSettingsSection: () => {},
      spaceName: "既定",
      conversationOnly: false,
      sessions: [],
      sessionId: "",
      agents: [],
      projects: [],
      newChat: () => {},
      selectSession: () => {},
      renameSession: () => {},
      handoffSession: () => {},
      deleteSession: () => {},
      deleteProject: () => {},
      togglePinned: () => {},
      commitHash,
    }),
  );
}

/**
 * 描画結果をブラウザーが読む文字列へ落とす。タグの分け方ではなく、画面に出る文言を検査する
 * (ハッシュだけを要素で包む変更で、表示が同じままテストが落ちないようにする)。
 */
function renderedText(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

test("コミットハッシュがあるときだけデプロイ済みビルドを出す", () => {
  assert.ok(renderedText(renderSidebar("673d6e4")).includes("ビルド 673d6e4"));
  assert.ok(!renderedText(renderSidebar()).includes("ビルド"));
});
