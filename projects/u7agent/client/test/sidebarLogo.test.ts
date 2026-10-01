// 左バーのロゴ。文字ではなく SVG で描く。
// 以前は文字の「✦」(U+2726) だったが、自前ホストの Noto Sans JP はこの字を持たず (fontsource の
// subset の unicode-range に無い) OS のフォントへフォールバックするため、字形・大きさ・位置が
// 端末ごとに変わり、iPhone では 32px の箱の中で星が下へずれて見えた。
// client に DOM テスト基盤が無いため、react-dom/server の描画で「箱の中身が SVG 1 つだけ」を固定する。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { Sidebar } from "../src/components/Sidebar";

function renderSidebar(): string {
  return renderToStaticMarkup(
    createElement(Sidebar, {
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
      deleteSession: () => {},
      deleteProject: () => {},
      onNewProject: () => {},
      onOpenSettingsSection: () => {},
      onClose: () => {},
      variant: "sidebar",
    }),
  );
}

/** ロゴの箱 (見出しの直前にある size-8 の箱) とその中身だけを取り出す */
function logoBox(html: string): string {
  const match = /<div class="grid size-8[^"]*">.*?<\/div>/.exec(html);
  assert.ok(match, "ロゴの箱が見つからない");
  return match[0];
}

test("ロゴの箱の中身は SVG 1 つで、文字は無い", () => {
  const html = renderSidebar();
  assert.ok(!html.includes("✦"), "文字の ✦ が残っている (字形と位置がフォント次第になる)");

  const box = logoBox(html);
  assert.equal((box.match(/<svg/g) ?? []).length, 1, "ロゴの SVG が 1 つでない");
  assert.equal(box.replace(/<[^>]*>/g, ""), "", "ロゴの箱に文字が残っている");
});

test("ロゴの星は 32px の箱に size-4 で置き、塗りで描く", () => {
  const box = logoBox(renderSidebar());
  assert.ok(/<svg[^>]*class="size-4 shrink-0"/.test(box), "ロゴの寸法が size-4 でない");
  assert.ok(/<svg[^>]*fill="currentColor"/.test(box), "ロゴが文字色で塗られていない");

  // 4 点星の外側の頂点は (8,2.5) (13.5,8) (8,13.5) (2.5,8)。16 のうち 11px が星の径で、32px の箱では
  // 文字の ✦ と同程度に見える。favicon.svg の星は 16px では腕が細いため、内側を広げた別の図形を使う
  assert.ok(
    box.includes('d="M8 2.5Q9.17 6.83 13.5 8Q9.17 9.17 8 13.5Q6.83 9.17 2.5 8Q6.83 6.83 8 2.5Z"'),
    "ロゴの星の図形が変わっている",
  );
});
