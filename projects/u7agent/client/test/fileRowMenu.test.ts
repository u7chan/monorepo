// ファイルツリーの行の ⋯ メニュー。client に DOM テスト基盤が無いため、出し分けと位置 / キーボード移動の
// 純関数を直接固定し、描画は react-dom/server で属性と並び順だけを見る。実ブラウザーでの light dismiss /
// top layer / フォーカス / スクロール追従は手動確認に残す (docs/file-preview.md#行の操作メニュー)。
//   1. readOnly は null、項目 0 は []、それ以外は ダウンロード → リネーム → 削除 (条件は現行どおり)
//   2. ⋯ は aria-haspopup / aria-expanded を持ち、本体は role="menu"、項目は role="menuitem" と tabIndex=-1
//   3. 位置は ⋯ の右下を既定にし、右端 / 下端では反転して viewport の内側へ clamp する
//   4. ↑↓ は端で止まる (循環しない)
//   5. 自前の close 経路は hidePopover() を通り、Escape は伝播だけ止める
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { fileRowActions, type FileRowAction } from "../src/lib/fileRowMenu";
import {
  nextRowMenuIndex,
  ROW_MENU_GAP,
  ROW_MENU_MARGIN,
  rowMenuAnchorVisible,
  rowMenuPlacement,
} from "../src/lib/rowMenu";

// FileBrowser / RowMenu は api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { EntryRowActions } = await import("../src/components/FileBrowser");
const { RowMenu } = await import("../src/components/RowMenu");

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

const base = {
  name: "docs",
  type: "dir" as const,
  canRename: false,
  readOnly: false,
  excludeNames: [] as readonly string[],
};

test("出し分け: ダウンロード → リネーム → 削除 を画面 / 種類 / symlink / 除外名どおりに返す", () => {
  assert.deepEqual(fileRowActions({ ...base, canRename: true }), [
    { kind: "download", label: "ZIP でダウンロード", description: "ビルド成果物と依存を除く" },
    { kind: "rename", label: "名前を変更" },
    { kind: "delete", label: "削除", danger: true },
  ]);
  // リネームは設定ツリー (canRename) のフォルダ行だけ。チャット右パネルはダウンロードと削除になる
  assert.deepEqual(fileRowActions(base), [
    { kind: "download", label: "ZIP でダウンロード", description: "ビルド成果物と依存を除く" },
    { kind: "delete", label: "削除", danger: true },
  ]);
  // ファイルはリネームを出さず、ダウンロードのラベルも ZIP ではなくなる (除外の開示も持たない)
  assert.deepEqual(fileRowActions({ ...base, type: "file", canRename: true }), [
    { kind: "download", label: "ダウンロード" },
    { kind: "delete", label: "削除", danger: true },
  ]);
});

test("出し分け: symlink は項目 0、除外名はダウンロードだけを落とし、readOnly は領域ごと消す", () => {
  // symlink はサンドボックスが 400 で拒否するため、ダウンロードも削除も出さない (領域は残す)
  for (const type of ["file", "dir"] as const) {
    assert.deepEqual(fileRowActions({ ...base, type, symlink: true, canRename: true }), [], type);
  }
  // 除外名の行はダウンロードだけを落とし、リネームと削除は残す (ファイルは削除だけ)
  assert.deepEqual(fileRowActions({ ...base, name: "node_modules", canRename: true, excludeNames: ["node_modules"] }), [
    { kind: "rename", label: "名前を変更" },
    { kind: "delete", label: "削除", danger: true },
  ]);
  assert.deepEqual(fileRowActions({ ...base, type: "file", name: "dist", excludeNames: ["dist"] }), [
    { kind: "delete", label: "削除", danger: true },
  ]);
  // readOnly (スキルのファイルタブ) は null。[] (項目 0) と区別できないと呼び出し側が空きスロットを置けない
  for (const props of [{ canRename: true }, { type: "file" as const }, { symlink: true }]) {
    assert.equal(fileRowActions({ ...base, ...props, readOnly: true }), null, JSON.stringify(props));
  }
});

function renderMenu(actions: readonly FileRowAction[], name = "docs"): string {
  return renderToStaticMarkup(createElement(RowMenu, { name, actions, onSelect: () => {} }));
}

test("描画: ⋯ は aria-haspopup / aria-expanded を持ち、本体は role=menu、項目は role=menuitem", () => {
  const html = renderMenu(fileRowActions({ ...base, canRename: true }) ?? []);
  assert.ok(html.includes('aria-haspopup="menu"'), "⋯ が aria-haspopup を持たない");
  assert.ok(html.includes('aria-expanded="false"'), "⋯ が aria-expanded を持たない");
  assert.ok(html.includes('aria-label="docs の操作"'), "⋯ の読み上げ名に行の名前が入っていない");
  assert.ok(html.includes('popover="auto"'), "本体が native popover でない");
  assert.ok(html.includes('role="menu"'), "本体が role=menu を持たない");
  // 本体は ⋯ を指す。useId の値は環境依存なので、同時に出た id 同士の一致で見る
  const triggerId = html.match(/id="([^"]+)-trigger"/)?.[1];
  assert.ok(triggerId, "⋯ に id が無い");
  assert.ok(html.includes(`aria-labelledby="${triggerId}-trigger"`), "本体が ⋯ を指していない");
  assert.ok(html.includes(`id="${triggerId}"`), "本体の id が ⋯ の popoverTarget と違う");
  // HTML の属性名は大文字小文字を区別しない (React の SSR は camelCase のまま出す)
  assert.ok(html.includes(`popoverTarget="${triggerId}"`), "⋯ が本体を toggle しない");

  // 項目は role=menuitem / tabIndex=-1 (Tab で外へ出る) で、並びは ダウンロード → リネーム → 削除
  assert.equal((html.match(/role="menuitem"/g) ?? []).length, 3, "項目数が違う");
  assert.equal((html.match(/tabindex="-1"/g) ?? []).length, 3, "項目が Tab の対象になっている");
  const download = html.indexOf("ZIP でダウンロード");
  const rename = html.indexOf("名前を変更");
  const remove = html.indexOf("削除");
  assert.ok(download >= 0 && download < rename && rename < remove, "並びが ダウンロード → リネーム → 削除 でない");
  // ディレクトリの除外は 2 行目へ移す (メニュー項目の文字ラベルとして出す)
  assert.ok(html.includes("ビルド成果物と依存を除く"), "除外の開示がメニュー項目に無い");
  // 削除だけ danger のトーンにする (ラベルとアイコンの 2 か所)
  const items = html.split("<button").filter((part) => part.includes('role="menuitem"'));
  assert.equal(items.length, 3, "項目数が違う");
  assert.ok(items[2].includes("text-danger-text"), "削除が danger でない");
  assert.ok(
    !items[0].includes("text-danger-text") && !items[1].includes("text-danger-text"),
    "削除以外に danger が付いている",
  );
});

test("描画: 項目 0 の行は空きスロット 1 個、readOnly は何も出さない", () => {
  const empty = renderToStaticMarkup(
    createElement(EntryRowActions, {
      name: "link",
      type: "dir",
      symlink: true,
      canRename: true,
      readOnly: false,
      excludeNames: [],
      onRename: () => {},
      onDelete: () => {},
      onDownload: () => {},
    }),
  );
  assert.ok(empty.includes('aria-hidden="true"'), "空きスロットが読み上げの対象になる");
  assert.ok(empty.includes('class="size-6 shrink-0"'), "空きスロットが ⋯ と同じ size-6 でない");
  assert.ok(!empty.includes("aria-haspopup"), "項目 0 の行に ⋯ を出している");
  assert.equal((empty.match(/size-6/g) ?? []).length, 1, "空きスロットが 1 個でない");

  const readOnly = renderToStaticMarkup(
    createElement(EntryRowActions, {
      name: "docs",
      type: "dir",
      canRename: true,
      readOnly: true,
      excludeNames: [],
      onRename: () => {},
      onDelete: () => {},
      onDownload: () => {},
    }),
  );
  assert.equal(readOnly, "", "readOnly に行の操作が出ている");
});

test("位置: ⋯ の右下を既定に、右端 / 下端では反転し、viewport の内側へ clamp する", () => {
  const anchor = { top: 100, left: 250, right: 274, bottom: 124 };
  const menu = { width: 160, height: 120 };
  const viewport = { width: 1024, height: 768 };
  // 既定: ⋯ の右端にメニューの右端を合わせ、⋯ の下へ ROW_MENU_GAP だけ離す
  assert.deepEqual(rowMenuPlacement(anchor, menu, viewport), {
    left: anchor.right - menu.width,
    top: anchor.bottom + ROW_MENU_GAP,
  });
  // 下端: 下に収まらないときは ⋯ の上へ倒す
  assert.equal(
    rowMenuPlacement({ top: 700, left: 250, right: 274, bottom: 724 }, menu, viewport).top,
    700 - ROW_MENU_GAP - menu.height,
  );
  // 上も下も収まらないときは clamp して下端の余白を残す (viewport より大きいメニュー)
  const tall = { width: 160, height: 700 };
  assert.equal(
    rowMenuPlacement({ top: 300, left: 250, right: 274, bottom: 324 }, tall, viewport).top,
    viewport.height - tall.height - ROW_MENU_MARGIN,
  );
  // 右端: 右寄せが入らないときは ⋯ の左端へ寄せ、それでも入らなければ左の余白で clamp する
  assert.equal(
    rowMenuPlacement({ top: 100, left: 4, right: 28, bottom: 124 }, menu, { width: 200, height: 768 }).left,
    ROW_MENU_MARGIN,
  );
  assert.equal(
    rowMenuPlacement({ top: 100, left: 4, right: 28, bottom: 124 }, menu, { width: 100, height: 768 }).left,
    ROW_MENU_MARGIN,
  );
});

test("可視判定: ⋯ がスクロール枠 / viewport の外へ出たら閉じる側に倒す", () => {
  const clip = { top: 0, left: 0, right: 300, bottom: 200 };
  const viewport = { top: 0, left: 0, right: 1024, bottom: 768 };
  assert.ok(rowMenuAnchorVisible({ top: 10, left: 10, right: 34, bottom: 34 }, [viewport, clip]));
  assert.ok(!rowMenuAnchorVisible({ top: 190, left: 10, right: 34, bottom: 214 }, [viewport, clip]), "枠の下端");
  assert.ok(!rowMenuAnchorVisible({ top: 10, left: 290, right: 314, bottom: 34 }, [clip]), "枠の右端");
  assert.ok(!rowMenuAnchorVisible({ top: -10, left: 10, right: 34, bottom: 14 }, [viewport, clip]), "上端");
});

test("↑↓ は端で止まり、フォーカスが項目の外にあるときは端の項目へ入る", () => {
  assert.equal(nextRowMenuIndex(0, 3, "next"), 1);
  assert.equal(nextRowMenuIndex(2, 3, "next"), 2, "末尾で循環した");
  assert.equal(nextRowMenuIndex(1, 3, "previous"), 0);
  assert.equal(nextRowMenuIndex(0, 3, "previous"), 0, "先頭で循環した");
  assert.equal(nextRowMenuIndex(-1, 3, "next"), 0);
  assert.equal(nextRowMenuIndex(-1, 3, "previous"), 2);
  assert.equal(nextRowMenuIndex(0, 0, "next"), -1);
});

test("配線: 自前の close は hidePopover() を通り、Escape は伝播だけ止める", () => {
  const source = read("src/components/RowMenu.tsx");
  // 本体は常時 mount し、開閉は popover の状態に任せる (React の条件付き mount で出し入れしない)
  assert.ok(source.includes('popover="auto"'), "native popover でない");
  assert.ok(!source.includes("createPortal"), "popover を portal している");
  assert.match(source, /addEventListener\("toggle"/, "toggle イベントを観測していない");
  assert.match(source, /newState === "open"/, "toggle イベントの状態を aria-expanded へ写していない");
  // 開閉は showPopover / hidePopover だけ。⋯ 自身の押下は popoverTarget で light dismiss の対象外にする
  assert.match(source, /popover\.showPopover\(\);/);
  assert.ok(source.includes("popoverTarget={menuId}"), "⋯ が light dismiss の対象外になっていない");
  // 項目の選択は、フォーカスを popover の外へ退避させてから hidePopover し、⋯ への native 復帰を
  // 抑える (戻すのは Escape だけ)。確認ダイアログ / prompt は閉じてから出す (背後に隠さない)
  assert.match(
    source,
    /closeBySelection\(\);\s*\n\s*onSelect\(action\.kind\);/,
    "項目の選択が closeBySelection を通らない",
  );
  assert.match(
    source,
    /popover\.contains\(active\)\) active\.blur\(\);\s*\n\s*popover\.hidePopover\(\);/,
    "項目の選択が hidePopover の前にフォーカスを外へ退避させていない",
  );
  // Tab で外へ出たとき (focusout) も hidePopover() で閉じる
  assert.match(source, /onBlur=\{onBlur\}/, "focusout で閉じていない");
  assert.match(source, /popoverRef\.current\?\.hidePopover\(\);/, "focusout が hidePopover を通らない");
  // Escape は標準の close に任せ、伝播だけ止める (App の Escape まで届かせない)
  const escape = source.slice(
    source.indexOf('if (event.key === "Escape")'),
    source.indexOf('if (event.key !== "ArrowDown"'),
  );
  assert.ok(escape.includes("event.stopPropagation()"), "Escape の伝播を止めていない");
  assert.ok(!escape.includes("hidePopover"), "Escape を自前で閉じている");
  // スクロール / リサイズで座標を取り直す。scroll は capture でツリーのスクロール枠の分も拾う
  assert.match(source, /window\.addEventListener\("scroll", onMove, true\)/, "scroll を capture で受けていない");
  assert.match(source, /window\.addEventListener\("resize", onMove\)/, "resize に追従していない");
  assert.match(source, /popover\.style\.left = `\$\{left\}px`;/, "座標を当てていない");
  assert.match(source, /trigger\.getBoundingClientRect\(\)/, "位置の基準が ⋯ の矩形でない");
  // 座標計算と index 移動は純関数へ切り出す (このファイルでは計算しない)
  assert.ok(source.includes("rowMenuPlacement(") && source.includes("nextRowMenuIndex("));
  // UA 既定の margin / border / padding / overflow を打ち消してからテーマのトークンを当てる
  for (const token of ["inset-auto", "m-0", "border-line", "bg-panel", "p-1", "overflow-visible", "shadow-panel"]) {
    assert.ok(source.includes(token), `popover の外装に ${token} が無い`);
  }
});

test("配線: レイアウトが変わった commit の後にも位置を取り直す", () => {
  const source = read("src/components/RowMenu.tsx");
  // サイドバーの docked ⇄ overlay のような React の再レンダーは window の resize ハンドラより後に
  // DOM へ届き、ハンドラ側の place() は動く前の rect を読む。commit 後の place() が無いと、1 回の
  // 離散リサイズで ⋯ だけが動き、次のイベントまでメニューが取り残される
  assert.match(source, /useLayoutEffect\(\(\) => \{\s*if \(open\) place\(\);\s*\}\);\n/, "commit 後の再配置が無い");
  // CSS だけが変わるリサイズ (viewport / @container) はイベント側の place() が拾う
  assert.match(source, /window\.addEventListener\("resize", onMove\)/, "resize での追従が無い");
});

test("アイコン: ⋯ の点 3 つを持ち、MenuIcon (ハンバーガー) とは別に使う", () => {
  const icons = read("src/components/icons.tsx");
  assert.match(icons, /export function MoreIcon\(\)/, "⋯ のアイコンが無い");
  const start = icons.indexOf("export function MoreIcon()");
  const end = icons.indexOf("export function CheckIcon()");
  const more = icons.slice(start, end);
  assert.equal((more.match(/<circle/g) ?? []).length, 3, "横並びの点 3 つでない");
  assert.ok(more.includes('aria-hidden="true"'), "アイコンが単体で読み上げの対象になる");
  assert.ok(read("src/components/RowMenu.tsx").includes("<MoreIcon />"), "⋯ が MoreIcon を使っていない");
});

test("MenuItem: danger / role / tabIndex / ref を受け、既存の呼び出しは既定のまま", () => {
  const source = read("src/components/MenuItem.tsx");
  assert.ok(source.includes("danger?: boolean;"), "danger の口が無い");
  assert.ok(source.includes('role?: "menuitem" | "option";'), "role の口が無い");
  assert.ok(source.includes("tabIndex?: number;"), "tabIndex の口が無い");
  assert.ok(source.includes("ref?: Ref<HTMLButtonElement>;"), "ref の口が無い");
  assert.match(source, /danger = false,/, "danger の既定が false でない");
  // 寸法は MenuItem の 1 箇所のままにする (メニュー側で新しい寸法を書かない)
  assert.ok(source.includes("min-h-7.5 w-full min-w-0 items-center gap-1.5 rounded-lg px-2 py-1"), "寸法が変わった");
});
