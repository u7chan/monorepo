// 左サイドバーのスクロール枠の内容幅を、あふれの有無 (スクロールバーの有無) に依存させない。
// client に DOM テスト基盤が無いため、Sidebar を react-dom/server で両 variant 描画して
// 「ガターが付く要素」を固定し、ガターのクラス定義はソース走査で固定する。
//   1. 一覧 / 設定ナビのガターが variant で欠ける (片方だけ幅が動く)
//   2. docked の <aside> にもガターが付く (スクロールしない枠の中身が狭くなる)
//   3. sheet の <aside> のガターが消える (drawer 全体のスクロールで一覧の幅が動く)
//   4. ガターの定義が @layer components から外れる / both-edges になる / scrollbar-thin に混ざる
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { Sidebar } from "../src/components/Sidebar";
import type { SidebarMode } from "../src/lib/settingsNav";

/** ガターのクラス。定義は client/src/styles/index.css の @layer components */
const GUTTER = "scrollbar-stable";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

function renderSidebar({ mode, variant }: { mode: SidebarMode; variant: "sidebar" | "sheet" }): string {
  return renderToStaticMarkup(
    createElement(Sidebar, {
      mode,
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
      deleteSession: () => {},
      deleteProject: () => {},
      onNewProject: () => {},
      onOpenSettingsSection: () => {},
      onClose: () => {},
      variant,
    }),
  );
}

/** ルートの <aside> の開きタグ。中の一覧にも同じクラスが付くため、先頭タグだけを見る */
function asideTag(html: string): string {
  const end = html.indexOf(">");
  assert.ok(html.startsWith("<aside ") && end > 0, "Sidebar のルートが <aside> でない");
  return html.slice(0, end + 1);
}

/** 一覧 (nav) か設定ナビ (settings) のスクロール枠。Sidebar の中では最初の 1 つ */
function scrollAreaTag(html: string): string {
  const match = /<div class="[^"]*scrollbar-thin[^"]*"/.exec(html);
  assert.ok(match, "scrollbar-thin を持つスクロール枠が無い");
  return match[0];
}

test("一覧のガターは variant に依らず、<aside> のガターは sheet のときだけ付く", () => {
  const docked = renderSidebar({ mode: "nav", variant: "sidebar" });
  const sheet = renderSidebar({ mode: "nav", variant: "sheet" });

  // 両方の variant でバー分を常に確保する (展開中 = 常用状態の幅へ揃える)
  assert.ok(scrollAreaTag(docked).includes(GUTTER), "docked の一覧にガターが無い");
  assert.ok(scrollAreaTag(sheet).includes(GUTTER), "sheet の一覧にガターが無い");

  // docked の <aside> は一覧が flex-1 で高さを吸収してスクロールしないので、ガターを取らない
  assert.ok(!asideTag(docked).includes(GUTTER), "docked の <aside> にガターが付いている");
  assert.ok(asideTag(sheet).includes(GUTTER), "sheet の <aside> にガターが無い");

  // 細いバーは variant を問わず <aside> に付ける (classic な 15px バーで一覧の幅を動かさない)
  assert.ok(asideTag(docked).includes("scrollbar-thin"), "docked の <aside> に scrollbar-thin が無い");
  assert.ok(asideTag(sheet).includes("scrollbar-thin"), "sheet の <aside> に scrollbar-thin が無い");
});

test("設定ナビのガターは variant に依らず、<aside> のガターは sheet のときだけ付く", () => {
  const docked = renderSidebar({ mode: "settings", variant: "sidebar" });
  const sheet = renderSidebar({ mode: "settings", variant: "sheet" });

  // 設定モードへ切り替えても一覧と同じ内容幅を保つ
  assert.ok(scrollAreaTag(docked).includes(GUTTER), "docked の設定ナビにガターが無い");
  assert.ok(scrollAreaTag(sheet).includes(GUTTER), "sheet の設定ナビにガターが無い");

  assert.ok(!asideTag(docked).includes(GUTTER), "docked の <aside> にガターが付いている");
  assert.ok(asideTag(sheet).includes(GUTTER), "sheet の <aside> にガターが無い");
});

test("ガターは @layer components の専用クラスで、scrollbar-thin には混ざらない", () => {
  const css = read("src/styles/index.css");
  const layer = css.indexOf("@layer components");
  const definition = css.indexOf(`.${GUTTER} {`);
  assert.ok(layer >= 0, "@layer components が無い");
  assert.ok(definition > layer, `.${GUTTER} が @layer components の外にある`);

  const block = css.slice(definition, css.indexOf("}", definition));
  assert.ok(block.includes("scrollbar-gutter: stable;"), `.${GUTTER} が scrollbar-gutter: stable でない`);
  // both-edges は左にもガターが付き、行の左端が動く
  assert.ok(!block.includes("both-edges"), "both-edges が付いている");
  // scrollbar-thin は他画面 (設定の一覧 / FileBrowser / ChatArea) とも共有するので巻き込まない
  assert.ok(!/\.scrollbar-thin \{[^}]*scrollbar-gutter/.test(css), "scrollbar-thin にガターが混ざっている");
});
