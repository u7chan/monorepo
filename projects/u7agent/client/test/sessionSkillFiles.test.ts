// チャットから開くスキル面の外装。SSR では FileBrowser の行を出さないため、見るのはヘッダ /
// root の表示 / 戻る導線 / 閉じる導線と、面のモードによる出し分けだけにする (行の操作は
// fileRowMenu.test.ts とブラウザ受入)。SSR の描画だけを確認し、要求の適用は test/fileRefRequest.test.ts。
import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { DEFAULT_FILES_MODE, type FilesMode } from "../src/lib/fileRefRequest";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { SessionFilesPanel } = await import("../src/components/SessionFilesPanel");
const { ConfirmProvider } = await import("../src/components/ConfirmProvider");

const RESIZE = {
  width: 360,
  min: 216,
  max: 216,
  resizable: false,
  preview: () => {},
  commit: () => {},
  reset: () => {},
};

const SKILL_ROOT = ".agents/skills/alpha";

function renderPanel(mode: FilesMode): string {
  const panel = createElement(SessionFilesPanel, {
    root: ".u7agent/sessions/s1",
    envScope: { sessionId: "s1" },
    excludeNames: [],
    runEndSeq: 0,
    onClose: () => {},
    mode,
    onBackToWork: () => {},
    resize: RESIZE,
  });
  return renderToStaticMarkup(createElement(ConfirmProvider, null, panel));
}

test("描画: スキル面は見出し / root / 戻る導線 / 閉じる導線を出し、作業フォルダ面の外装を出さない", () => {
  const html = renderPanel({ kind: "skill", root: SKILL_ROOT });
  assert.ok(html.includes('aria-label="スキル"'), "面の名前がスキルになっていない");
  assert.ok(html.includes(">スキル<"), "見出しが出ていない");
  assert.ok(html.includes(SKILL_ROOT), "root が出ていない");
  assert.ok(html.includes("作業フォルダへ戻る"), "戻る導線が無い");
  assert.ok(html.includes('aria-label="閉じる"'), "閉じる導線が無い");
  // タブ (作業フォルダ / 環境変数) と「再読み込み」はスキル面に持たせない
  assert.ok(!html.includes(">作業環境<"), "作業環境の見出しが混ざっている");
  assert.ok(!html.includes("環境変数"), "環境変数タブが混ざっている");
  assert.ok(!html.includes("再読み込み"), "作業フォルダ面の操作行が混ざっている");
});

test("描画: 作業フォルダ面 (既定) は従来どおりの外装のまま", () => {
  const html = renderPanel(DEFAULT_FILES_MODE);
  assert.ok(html.includes('aria-label="作業環境"'), "面の名前が変わった");
  assert.ok(html.includes(">作業環境<"), "見出しが変わった");
  assert.ok(html.includes(">環境変数<"), "環境変数タブが無い");
  assert.ok(html.includes("再読み込み"), "作業フォルダ面の操作行が無い");
  assert.ok(!html.includes("作業フォルダへ戻る"), "作業フォルダ面に戻る導線が出ている");
});
