import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { SettingsPageLayout } from "../src/components/SettingsPageLayout";
import { Topbar } from "../src/components/Topbar";
import type { RuntimeStatus } from "../src/hooks/runtimeStatus";
import { serveProps } from "./serve-fixture";

const IDLE: RuntimeStatus = { text: "", error: false };
/** 作業先チップ。☰ の位置だけを見るテストなので値は固定でよい */
const SCOPE = { label: "未所属", project: false, root: "" };
/** 読み上げ名。singleColumn の SingleColumnBar と設定ページのヘッダも同じ名前を使う */
const NAV_MARK = 'aria-label="ナビゲーションを開く"';

function renderTopbar(nav?: { onOpen: () => void }): string {
  return renderToStaticMarkup(
    createElement(Topbar, {
      serve: serveProps(),
      scope: SCOPE,
      runtimeStatus: IDLE,
      notify: { on: false, ring: 0, deliverable: true, onToggle: () => {} },
      nav,
    }),
  );
}

function renderSettingsHeader(options: { onOpenNav?: () => void; singleColumn?: boolean } = {}): string {
  return renderToStaticMarkup(
    createElement(SettingsPageLayout, {
      eyebrow: "SETTINGS",
      title: "エージェント",
      onBack: () => {},
      onOpenNav: options.onOpenNav,
      singleColumn: options.singleColumn,
      children: null,
    }),
  );
}

test("desktop のバーは overlay のときだけ ☰ を作業先チップの左に出す", () => {
  const overlay = renderTopbar({ onOpen: () => {} });
  assert.ok(overlay.indexOf(NAV_MARK) < overlay.indexOf(SCOPE.label), "☰ が作業先チップより右にある");
  assert.match(overlay, /<button[^>]*aria-label="ナビゲーションを開く"/);
  // docked では左バーが常駐するので出さない
  assert.ok(!renderTopbar().includes(NAV_MARK));
});

test("設定ページのヘッダの ☰ は overlay の desktop でも出す", () => {
  const overlay = renderSettingsHeader({ onOpenNav: () => {} });
  assert.ok(overlay.includes(NAV_MARK));
  assert.ok(!renderSettingsHeader().includes(NAV_MARK));
});

test("「アプリに戻る」は singleColumn だけヘッダ左端 (☰ の左) に出す", () => {
  // desktop の戻り導線は左バーの 1 つ
  assert.ok(!renderSettingsHeader({ onOpenNav: () => {} }).includes("アプリに戻る"));
  const singleColumn = renderSettingsHeader({ onOpenNav: () => {}, singleColumn: true });
  const backAt = singleColumn.indexOf("アプリに戻る");
  assert.ok(backAt >= 0, "「アプリに戻る」が無い");
  assert.ok(backAt < singleColumn.indexOf(NAV_MARK), "戻るは ☰ の左に置く");
  assert.ok(backAt < singleColumn.indexOf(">エージェント<"), "戻るはタイトルより前 (ヘッダ左端) に置く");
});

test("詳細を開いている間はページの見出しと説明を落とし、操作行だけにする", () => {
  const html = renderToStaticMarkup(
    createElement(SettingsPageLayout, {
      eyebrow: "SETTINGS",
      title: "エージェント",
      caption: "会話の役割と、割り当てるスキルとツールを定義します。",
      onBack: () => {},
      onOpenNav: () => {},
      singleColumn: true,
      collapseHeader: true,
      children: createElement("p", null, "本文"),
    }),
  );
  // 見出しと説明の分の高さを本文へ譲る (項目の名前は詳細のヘッダが出す)
  assert.ok(!html.includes("エージェント"), "ページの見出しが残っている");
  assert.ok(!html.includes("会話の役割と"), "ページの説明が残っている");
  // 設定の外へ出る導線は残す
  assert.ok(html.includes("アプリに戻る"));
  assert.ok(html.includes(NAV_MARK));
  assert.ok(html.includes("本文"));
});
