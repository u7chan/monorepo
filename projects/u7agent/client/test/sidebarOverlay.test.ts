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
/** 読み上げ名。compact の CompactBar と設定ページのヘッダも同じ名前を使う */
const NAV_MARK = 'aria-label="ナビゲーションを開く"';

function renderTopbar(nav?: { onOpen: () => void }): string {
  return renderToStaticMarkup(
    createElement(Topbar, {
      serve: serveProps(),
      scope: SCOPE,
      runtimeStatus: IDLE,
      notify: { on: false, deliverable: true, onToggle: () => {} },
      nav,
    }),
  );
}

function renderSettingsHeader(options: { onOpenNav?: () => void; compact?: boolean } = {}): string {
  return renderToStaticMarkup(
    createElement(SettingsPageLayout, {
      eyebrow: "SETTINGS",
      title: "エージェント",
      onBack: () => {},
      onOpenNav: options.onOpenNav,
      compact: options.compact,
      children: null,
    }),
  );
}

test("desktop のバーは overlay のときだけ ☰ を eyebrow の左に出す", () => {
  const overlay = renderTopbar({ onOpen: () => {} });
  assert.ok(overlay.indexOf(NAV_MARK) < overlay.indexOf("LOCAL WORKSPACE"), "☰ が eyebrow より右にある");
  assert.match(overlay, /<button[^>]*aria-label="ナビゲーションを開く"/);
  // docked では左バーが常駐するので出さない
  assert.ok(!renderTopbar().includes(NAV_MARK));
});

test("設定ページのヘッダの ☰ は overlay の desktop でも出す", () => {
  const overlay = renderSettingsHeader({ onOpenNav: () => {} });
  assert.ok(overlay.includes(NAV_MARK));
  assert.ok(!renderSettingsHeader().includes(NAV_MARK));
  // 「アプリに戻る」は compact だけ (desktop の戻り導線は左バーの 1 つ)
  assert.ok(!overlay.includes("アプリに戻る"));
  const compact = renderSettingsHeader({ onOpenNav: () => {}, compact: true });
  assert.ok(compact.includes(NAV_MARK));
  assert.ok(compact.includes("アプリに戻る"));
});
