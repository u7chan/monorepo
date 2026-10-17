// 引き継ぎの専用ダイアログ。候補の一覧・既定・無効理由は純関数では固定できないため SSR で描画して検査する
// (送信の直列化・失敗表示・焦点はブラウザの受入で確認する)。

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { Space } from "server";
import { SessionHandoffDialog } from "../src/components/SessionHandoffDialog";
import { handoffAgentChoices, sessionHandoffDialogText } from "../src/lib/sessionHandoff";
import type { AgentDef } from "../src/types";

const normal: Space = { id: "default", name: "既定", createdAt: 0 };
const demo: Space = { id: "space-1111111111111111", name: "デモ", createdAt: 1 };
const general: AgentDef = {
  id: "general",
  name: "汎用アシスタント",
  description: "",
  systemPrompt: "",
};
const research: AgentDef = { ...general, id: "research", name: "調査" };

function render(overrides: Partial<Parameters<typeof SessionHandoffDialog>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(SessionHandoffDialog, {
      text: sessionHandoffDialogText("決済画面の検証"),
      agents: handoffAgentChoices([general, research], general.id, general.name),
      spaces: [normal, demo],
      currentSpaceId: normal.id,
      projectSession: false,
      memoDisabledReason: "",
      blockedNote: "",
      onClose: () => {},
      onHandoff: async () => {},
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

test("既定 (現在のエージェント・現在のスペース・メモ ON) で、確認文言と候補を並べる", () => {
  const html = render();
  assert.ok(html.includes('aria-label="会話を引き継ぐ"'), "見出しが読み上げ名になっていない");
  assert.ok(html.includes("決済画面の検証"), "対象のタイトルが出ていない");
  assert.ok(html.includes("汎用アシスタント（現在）"), "現在のエージェントの印が無い");
  assert.ok(html.includes("調査"), "引き継ぎ先のエージェントが出ていない");
  assert.ok(html.includes("既定（現在）") && html.includes("デモ"), "移動先の候補に現在のスペースが無い");
  assert.ok(html.includes("HANDOFF.md"), "メモの説明が無い");
  assert.ok(html.includes("履歴") && html.includes("破棄"), "履歴が破棄されることが出ていない");
  assert.ok(html.includes("切り替わ"), "引き継ぎ後のスペース切替が本文に無い");
  assert.ok(!submitButton(html).includes("disabled"), "既定で確定が無効になっている");
  assert.match(html, /<button[^>]*type="submit"[^>]*>引き継ぐ<\/button>/, "確定の名前が違う");
  // メモのトグルは既定 ON (材料があるとき)
  assert.match(html, /role="switch"[^>]*aria-checked="true"/, "メモのトグルが既定 ON でない");
});

test("実行中の会話は理由を出して確定を無効にする", () => {
  const html = render({
    blockedNote: "実行中・キュー待ち・圧縮中は引き継げません。完了を待ってから開き直してください。",
  });
  assert.ok(html.includes("実行中・キュー待ち・圧縮中は引き継げません"), "無効の理由が出ていない");
  assert.ok(submitButton(html).includes("disabled"), "実行中なのに確定を押せてしまう");
});

test("メッセージ 0 件ではメモのトグルを無効にして理由を出し、確定は押せる", () => {
  const html = render({ memoDisabledReason: "メモにできる会話がまだありません。" });
  assert.ok(html.includes("メモにできる会話がまだありません。"), "0 件の理由が出ていない");
  assert.match(html, /role="switch"[^>]*disabled/, "メモのトグルが有効なままになっている");
  assert.match(html, /role="switch"[^>]*aria-checked="false"/, "材料が無いのにメモ ON になっている");
  assert.ok(!submitButton(html).includes("disabled"), "メモを外せば引き継げるのに確定が無効になっている");
});

test("プロジェクト所属では移動先スペースを出さず、メモの保存先とコミット / 除外の判断を出す", () => {
  const html = render({ projectSession: true, text: sessionHandoffDialogText("決済画面の検証", true) });
  // スペースの選択肢 (現在のスペース以外) を出さない
  assert.ok(!html.includes("デモ"), "プロジェクト所属でスペースの選択が出ている");
  assert.ok(html.includes("HANDOFF.md"), "メモの説明まで消えている");
  assert.ok(html.includes("リポジトリ直下"), "メモの保存先が出ていない");
  assert.ok(html.includes("コミット") && html.includes("除外"), "コミット / 除外の判断が出ていない");
  assert.ok(!submitButton(html).includes("disabled"), "同じスペースへの引き継ぎが押せない");

  // 未所属ではプロジェクトの注意を出さない
  assert.ok(!render().includes("リポジトリ直下"), "未所属にプロジェクトの注意が出ている");
});
