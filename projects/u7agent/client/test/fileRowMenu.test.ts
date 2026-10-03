import assert from "node:assert/strict";

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
