// 左バーを overlay へ退避する帯 (desktop の 1200px 未満) の配線。client に DOM テスト基盤が無いため、
// バーの ☰ は react-dom/server で描画して出し分けを固定し、App と NavSheet の分岐はソース走査で固定する。
//   1. docked は 2 カラム + Sidebar 常駐、overlay は 1 カラム + ☰ (Topbar / 設定ページのヘッダ)
//   2. docked へ戻ったらドロワーを閉じ、docked の Sidebar と重ねて描かない
//   3. 1199 → 1200 を跨ぐと ☰ ごと消えるため、focus の戻し先が切れていたら docked の Sidebar へ移す
//   4. 右パネルの上限は overlay のとき main = viewport 幅で計算する (#1540 の mainWidth)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { SettingsPageLayout } from "../src/components/SettingsPageLayout";
import { Topbar } from "../src/components/Topbar";
import type { RuntimeStatus } from "../src/hooks/runtimeStatus";

const IDLE: RuntimeStatus = { text: "", error: false };
/** 読み上げ名。compact の CompactBar と設定ページのヘッダも同じ名前を使う */
const NAV_MARK = 'aria-label="ナビゲーションを開く"';

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

function renderTopbar(nav?: { onOpen: () => void }): string {
  return renderToStaticMarkup(
    createElement(Topbar, {
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
  // 左バーを開く唯一の導線なので、compact と同じ 36px のアイコンボタン (.icon-button) にする
  assert.ok(overlay.includes(`<button type="button" ${NAV_MARK} class="icon-button">`));
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

test("App: docked は 2 カラム + Sidebar 常駐、overlay は 1 カラム + ☰", () => {
  const app = read("src/App.tsx");
  assert.ok(app.includes('sidebarDocked ? "grid-cols-[252px_minmax(0,1fr)] grid-rows-1" : "grid-cols-1 grid-rows-1"'));
  assert.ok(app.includes("{sidebarDocked ? <Sidebar {...navProps} /> : null}"));
  assert.ok(app.includes("nav={sidebarDocked ? undefined : { onOpen: openNav }}"));
  assert.ok(app.includes("onOpenNav: sidebarDocked ? undefined : openNav"));
  // 右パネルの上限は overlay のとき 252px 増える (main = viewport 幅)
  assert.ok(app.includes("mainWidth: sidebarDocked ? viewportWidth - SIDEBAR_WIDTH : viewportWidth"));
  // docked へ戻ったらドロワーを閉じ、docked の Sidebar と重ねて描かない
  assert.ok(app.includes("if (sidebarDocked) setNavOpen(false);"));
  assert.ok(app.includes("{navOpen && !sidebarDocked ? <NavSheet {...drawerProps} onClose={closeNav} /> : null}"));
});

test("NavSheet は起点が切れていたら docked の Sidebar へ focus を移す", () => {
  const sheet = read("src/components/NavSheet.tsx");
  assert.ok(sheet.includes("if (previous?.isConnected) {"));
  assert.ok(sheet.includes("const DOCKED_NAV_FOCUS_SELECTOR = '[data-nav-root=\"docked\"] button';"));
  assert.ok(sheet.includes("document.querySelector<HTMLElement>(DOCKED_NAV_FOCUS_SELECTOR)?.focus();"));
  // 置き方は Sidebar が持ち、dialog の中の Sidebar (sheet) は選択子で拾わない
  assert.ok(read("src/components/Sidebar.tsx").includes('data-nav-root={sheet ? "sheet" : "docked"}'));
});
