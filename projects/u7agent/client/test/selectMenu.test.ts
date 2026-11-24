// 設定画面の自前 select。位置とキーボード移動は純関数で、描画は react-dom/server の静的描画で固定する
// (client に DOM テスト基盤が無いため、開閉そのものは native popover に任せて検査しない)。

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { SelectMenu } from "../src/components/SelectMenu";
import {
  filterSelectMenuOptions,
  initialSelectMenuIndex,
  selectMenuPlacement,
  SELECT_MENU_MIN_BELOW,
} from "../src/lib/selectMenu";

const OPTIONS = [
  { value: "exa", label: "Exa", detail: "mcp.exa.ai", description: "キー不要（keyless の共有エンドポイント）" },
  {
    value: "tavily",
    label: "Tavily",
    detail: "api.tavily.com",
    description: "APIキーが必要（平文で保存）",
    group: "キー登録が必要",
  },
] as const;

function render(options: { value?: "exa" | "tavily"; note?: string; disabled?: boolean } = {}): string {
  return renderToStaticMarkup(
    createElement(SelectMenu, {
      label: "検索プロバイダー",
      value: options.value ?? "exa",
      options: [...OPTIONS],
      note: options.note,
      disabled: options.disabled ?? false,
      onChange: () => {},
    }),
  );
}

test("位置: 既定は下に開き、下が狭いときだけ上へ倒す", () => {
  // 下に十分な空きがある (下が狭くても上より広ければそのまま下)
  assert.deepEqual(selectMenuPlacement({ top: 100, bottom: 140 }, 900), { above: false, maxHeight: 748 });
  // 下が分かれ目未満で、上により広い空きがある
  const anchor = { top: 700, bottom: 740 };
  assert.deepEqual(selectMenuPlacement(anchor, 760), { above: true, maxHeight: 688 });
  // どちらも狭いときは下のまま (上へ倒しても読めない)
  assert.deepEqual(selectMenuPlacement({ top: 40, bottom: 80 }, 200), { above: false, maxHeight: 108 });
  assert.equal(SELECT_MENU_MIN_BELOW, 120);
});

test("位置: 高さの上限は負にしない", () => {
  assert.deepEqual(selectMenuPlacement({ top: 0, bottom: 0 }, 0), { above: false, maxHeight: 0 });
});

test("開いたときのフォーカスは選択中の行、無ければ先頭", () => {
  assert.equal(initialSelectMenuIndex("tavily", ["exa", "tavily"]), 1);
  assert.equal(initialSelectMenuIndex("brave", ["exa", "tavily"]), 0);
  assert.equal(initialSelectMenuIndex("exa", []), 0);
});

test("トリガーは選択中の名前と副表示を出し、listbox を参照する", () => {
  const html = render();
  assert.match(html, /<button[^>]*aria-haspopup="listbox"/);
  assert.match(html, /<button[^>]*aria-label="検索プロバイダー"/);
  const trigger = html.slice(0, html.indexOf("<div "));
  assert.ok(trigger.includes(">Exa<"), "選択中の名前を出す");
  assert.ok(trigger.includes("mcp.exa.ai"), "選択中の送信先を出す");
  assert.equal(trigger.includes("api.tavily.com"), false, "選択していない provider はトリガーに出さない");
  const controls = html.match(/aria-controls="([^"]+)"/)?.[1];
  assert.ok(controls !== undefined && html.includes(`id="${controls}"`), "aria-controls が popover を指す");
});

test("一覧は行の説明と副表示を出し、選択中の行だけ aria-selected=true にする", () => {
  const html = render({ value: "tavily" });
  assert.equal((html.match(/role="option"/g) ?? []).length, 2);
  assert.match(html, /role="option"[^>]*aria-selected="true"[^>]*>[\s\S]*?>Tavily</, "選択中の行を Tavily にする");
  assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1, "選択は 1 行だけ");
  assert.ok(html.includes("キー不要（keyless の共有エンドポイント）"), "行の説明を出す");
  assert.ok(html.includes("APIキーが必要（平文で保存）"), "行の説明を出す");
  assert.ok(html.includes('role="group" aria-label="キー登録が必要"'), "見出しつきの行は group に入れる");
});

test("注記は一覧の外に出す (listbox の中に option 以外を置かない)", () => {
  const html = render({ note: "選択は下に出す設定の切替だけです。" });
  const listbox = html.slice(html.indexOf('role="listbox"'), html.indexOf("</div></div>"));
  assert.equal(listbox.includes("選択は下に出す設定の切替だけです。"), false);
  assert.ok(html.includes("選択は下に出す設定の切替だけです。"));
  assert.equal(render().includes("選択は下に出す設定の切替だけです。"), false, "注記が無ければ出さない");
});

test("印 (leading) は行とトリガーの左に出し、無い行では幅を空けない", () => {
  const html = renderToStaticMarkup(
    createElement(SelectMenu, {
      label: "検索プロバイダー",
      value: "exa" as const,
      options: [{ ...OPTIONS[0], leading: createElement("span", null, "●") }],
      onChange: () => {},
    }),
  );
  assert.equal((html.match(/●/g) ?? []).length, 2, "トリガーと行の 2 か所に出す");
});

test("無効のときはトリガーを押せなくする", () => {
  assert.match(render({ disabled: true }), /<button[^>]*aria-label="検索プロバイダー"[^>]*\sdisabled=""/);
  assert.equal(/\sdisabled=""/.test(render()), false, "既定は押せる");
});

test("絞り込みは見出し・副表示・説明のどれでも当て、空の語では全件を残す", () => {
  assert.deepEqual(
    filterSelectMenuOptions([...OPTIONS], "").map((option) => option.value),
    ["exa", "tavily"],
  );
  assert.deepEqual(
    filterSelectMenuOptions([...OPTIONS], "  ").map((option) => option.value),
    ["exa", "tavily"],
    "空白だけの語は絞り込まない",
  );
  assert.deepEqual(
    filterSelectMenuOptions([...OPTIONS], "TAVILY").map((option) => option.value),
    ["tavily"],
    "大文字小文字を無視して主表示に当てる",
  );
  assert.deepEqual(
    filterSelectMenuOptions([...OPTIONS], "exa.ai").map((option) => option.value),
    ["exa"],
    "副表示（ホスト名）でも引ける",
  );
  assert.deepEqual(
    filterSelectMenuOptions([...OPTIONS], "平文").map((option) => option.value),
    ["tavily"],
    "説明でも引ける",
  );
  assert.deepEqual(
    filterSelectMenuOptions([...OPTIONS], "キー登録").map((option) => option.value),
    ["tavily"],
    "見出しでも引ける (見出しの語を前置きしない行を名前で辿れる)",
  );
  assert.deepEqual(filterSelectMenuOptions([...OPTIONS], "brave"), []);
});

test("検索できる一覧は検索欄と操作の行を listbox の外に出す", () => {
  const html = renderToStaticMarkup(
    createElement(SelectMenu, {
      label: "検索プロバイダー",
      value: "exa" as const,
      options: [...OPTIONS],
      searchable: true,
      searchPlaceholder: "プロバイダーで絞り込み",
      controls: createElement("button", { type: "button" }, "並び順"),
      onChange: () => {},
    }),
  );
  assert.match(html, /<input[^>]*type="search"[^>]*aria-label="プロバイダーで絞り込み"/);
  assert.ok(html.includes(">並び順</button>"), "操作は呼び出し側の見た目のまま出す");
  // 検索と操作の行は listbox より前に置く (行以外を listbox の中に入れない)
  assert.ok(html.indexOf('type="search"') < html.indexOf('role="listbox"'));
  assert.ok(html.indexOf(">並び順</button>") < html.indexOf('role="listbox"'));
  // 検索欄を持たない呼び出しでは今までどおり出さない
  assert.equal(render().includes('type="search"'), false);
});
