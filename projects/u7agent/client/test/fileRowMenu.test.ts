import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { fileRowActions, fileRowShareTarget, type FileRowAction } from "../src/lib/fileRowMenu";
import { SHARE_RUNNING_NOTE } from "../src/lib/sharedContents";
import {
  nextRowMenuIndex,
  ROW_MENU_GAP,
  ROW_MENU_MARGIN,
  rowMenuAnchorVisible,
  rowMenuDescriptionKind,
  rowMenuPlacement,
} from "../src/lib/rowMenu";

// FileBrowser / RowMenu は api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { EntryRowActions } = await import("../src/components/FileBrowser");
const { PathCopyFailure } = await import("../src/components/file-tree/PathCopyFailure");
const { RowMenu } = await import("../src/components/RowMenu");

const base = {
  name: "docs",
  type: "dir" as const,
  canRename: false,
  readOnly: false,
  excludeNames: [] as readonly string[],
};

/** 全行に出す項目。出し分けの比較で同じ値を使い回す */
const copyPath = {
  kind: "copy-path",
  label: "パスをコピー",
  description: "ツリーの root からの相対パス",
  descriptionKind: "note",
};
/** health.cwd を渡した行だけに出る項目。2 行目を持たないので singleColumn でも文字が消えない */
const copyAbsolutePath = { kind: "copy-absolute-path", label: "絶対パスをコピー" };
/** ZIP の除外は押す前に知る必要があるので singleColumn でも残す */
const downloadDir = {
  kind: "download",
  label: "ZIP でダウンロード",
  description: "ビルド成果物と依存を除く",
  descriptionKind: "disclosure",
};
/** 共有は押す前に serve との違いを知る必要があるので singleColumn でも残す */
const shareDir = {
  kind: "share",
  label: "共有",
  description: "Cloudflare へ静的公開（サービスは一時プレビュー）",
  descriptionKind: "disclosure",
};
/** root 直下の index.html 行の共有。ファイル行なのにフォルダ全体が上がることを 2 行目で開示する */
const shareSessionRoot = {
  kind: "share",
  label: "このフォルダを共有",
  description: "index.html と同じフォルダの成果物を公開",
  descriptionKind: "disclosure",
};
const deleteDir = { kind: "delete", label: "削除", danger: true };

test("出し分け: パスをコピー → ダウンロード → リネーム → 削除 を画面 / 種類 / symlink / 除外名どおりに返す", () => {
  assert.deepEqual(fileRowActions({ ...base, canRename: true }), [
    copyPath,
    downloadDir,
    { kind: "rename", label: "名前を変更" },
    { kind: "delete", label: "削除", danger: true },
  ]);
  // リネームは設定ツリー (canRename) のフォルダ行だけ。チャット右パネルはダウンロードと削除になる
  assert.deepEqual(fileRowActions(base), [copyPath, downloadDir, { kind: "delete", label: "削除", danger: true }]);
  // ファイルはリネームを出さず、ダウンロードのラベルも ZIP ではなくなる (除外の開示も持たない)
  assert.deepEqual(fileRowActions({ ...base, type: "file", canRename: true }), [
    copyPath,
    { kind: "download", label: "ダウンロード" },
    { kind: "delete", label: "削除", danger: true },
  ]);
});

test("出し分け: 共有は共有できる面のディレクトリ行だけに、ダウンロードより前に出す", () => {
  assert.deepEqual(fileRowActions({ ...base, canShare: true }), [copyPath, shareDir, downloadDir, deleteDir]);
  // ファイル行には出さない (共有は 1 ディレクトリ単位で、index.html の確認は公開ジョブが行う)
  assert.deepEqual(fileRowActions({ ...base, type: "file", canShare: true }), [
    copyPath,
    { kind: "download", label: "ダウンロード" },
    deleteDir,
  ]);
  // symlink はサンドボックスがワークスペース外を指し得るため共有しない
  assert.deepEqual(fileRowActions({ ...base, symlink: true, canShare: true }), [copyPath]);
  // 設定 → ファイル は directory の基準が違うため共有を出さない (canShare を渡さない)
  assert.deepEqual(fileRowActions(base), [copyPath, downloadDir, deleteDir]);
  assert.deepEqual(fileRowActions({ ...base, canShare: true, readOnly: true }), [copyPath]);
});

// 作業フォルダ自身 (root 直下の index.html) の共有。ディレクトリ行の「共有」とは別の項目で、
// プロジェクト会話では出さない (呼び出し側の canShareSessionRoot が判断する)。
test("出し分け: root の index.html 行だけ「このフォルダを共有」を出し、対象は親 (.) になる", () => {
  const rootIndex = { ...base, name: "index.html", type: "file" as const, depth: 0, canShare: true };
  assert.deepEqual(fileRowActions({ ...rootIndex, canShareSessionRoot: true }), [
    copyPath,
    shareSessionRoot,
    { kind: "download", label: "ダウンロード" },
    deleteDir,
  ]);
  // canShareSessionRoot を渡さない / false の面では出さない (設定 → ファイル・プロジェクト会話・旧サーバー)
  for (const canShareSessionRoot of [undefined, false]) {
    const actions = fileRowActions({ ...rootIndex, canShareSessionRoot });
    assert.equal(
      actions?.some((action) => action.label === shareSessionRoot.label),
      false,
      String(canShareSessionRoot),
    );
  }
  // サブディレクトリの index.html はディレクトリ行の「共有」で足りる (深さ 1 以上では出さない)
  const nested = fileRowActions({ ...rootIndex, depth: 1, canShareSessionRoot: true });
  assert.equal(
    nested?.some((action) => action.label === shareSessionRoot.label),
    false,
  );
  // index.html 以外のファイル、ディレクトリ行、symlink にも出さない
  for (const props of [{ name: "app.html" }, { type: "dir" as const, name: "index.html" }, { symlink: true }]) {
    const actions = fileRowActions({ ...rootIndex, ...props, canShareSessionRoot: true });
    assert.equal(
      actions?.some((action) => action.label === shareSessionRoot.label),
      false,
      JSON.stringify(props),
    );
  }
  // 共有の対象: ファイル行は親 (root 直下は ".")、ディレクトリ行は自分自身
  assert.equal(fileRowShareTarget({ type: "file", path: "index.html", parent: "." }), ".");
  assert.equal(fileRowShareTarget({ type: "dir", path: "site", parent: "." }), "site");
  assert.equal(fileRowShareTarget({ type: "file", path: "site/index.html", parent: "site" }), "site");
});

// What: 実行中は共有の項目を消さず、押せない理由を 2 行目に出す (項目ごと隠すと理由が分からない)
test("出し分け: 共有の押せない理由は項目を残して 2 行目へ出し、run が終われば元に戻る", () => {
  const blockedDir = { ...shareDir, description: SHARE_RUNNING_NOTE, disabled: true };
  assert.deepEqual(fileRowActions({ ...base, canShare: true, shareBlockedReason: SHARE_RUNNING_NOTE }), [
    copyPath,
    blockedDir,
    downloadDir,
    deleteDir,
  ]);
  // 作業フォルダ自身の入口も同じ扱い
  const rootIndex = { ...base, name: "index.html", type: "file" as const, depth: 0, canShare: true };
  assert.deepEqual(
    fileRowActions({ ...rootIndex, canShareSessionRoot: true, shareBlockedReason: SHARE_RUNNING_NOTE }),
    [
      copyPath,
      { ...shareSessionRoot, description: SHARE_RUNNING_NOTE, disabled: true },
      { kind: "download", label: "ダウンロード" },
      deleteDir,
    ],
  );
  // 理由が無ければ今までどおり押せる (disabled を持たない)
  assert.deepEqual(fileRowActions({ ...base, canShare: true }), [copyPath, shareDir, downloadDir, deleteDir]);
});

test("出し分け: ディレクトリ行の「共有」はセッション種別に関係なく出し続ける", () => {
  // canShareSessionRoot (作業フォルダ自身の入口) はプロジェクト会話で false になるが、
  // ディレクトリ行の「共有」は canShare だけで決まる (既存の共有をプロジェクト会話でも使えるままにする)
  for (const canShareSessionRoot of [true, false]) {
    assert.deepEqual(fileRowActions({ ...base, canShare: true, canShareSessionRoot }), [
      copyPath,
      shareDir,
      downloadDir,
      deleteDir,
    ]);
  }
});

test("出し分け: symlink はパスをコピーだけ、除外名はダウンロードを落とし、readOnly はコピーだけ残す", () => {
  // symlink はサンドボックスが 400 で拒否するため、ダウンロードも削除も出さない。相対パスは取れるのでコピーだけ残す
  for (const type of ["file", "dir"] as const) {
    assert.deepEqual(fileRowActions({ ...base, type, symlink: true, canRename: true }), [copyPath], type);
  }
  // 除外名の行はダウンロードだけを落とし、コピーとリネームと削除は残す (ファイルはコピーと削除だけ)
  assert.deepEqual(fileRowActions({ ...base, name: "node_modules", canRename: true, excludeNames: ["node_modules"] }), [
    copyPath,
    { kind: "rename", label: "名前を変更" },
    { kind: "delete", label: "削除", danger: true },
  ]);
  assert.deepEqual(fileRowActions({ ...base, type: "file", name: "dist", excludeNames: ["dist"] }), [
    copyPath,
    { kind: "delete", label: "削除", danger: true },
  ]);
  // readOnly (スキルのファイルタブ) はダウンロード以下を落とし、どの行もパスをコピーを残す
  for (const props of [{ canRename: true }, { type: "file" as const }, { symlink: true }]) {
    assert.deepEqual(fileRowActions({ ...base, ...props, readOnly: true }), [copyPath], JSON.stringify(props));
  }
});

test("出し分け: 絶対パスのコピーは絶対パスを渡した行だけに出す", () => {
  const withAbsolute = fileRowActions({ ...base, absolutePath: "/srv/workspace/docs" });
  assert.deepEqual(withAbsolute, [
    copyPath,
    copyAbsolutePath,
    downloadDir,
    { kind: "delete", label: "削除", danger: true },
  ]);
  // health 未取得 (undefined) の間は字面を作れないため出さない。既存の並びは変わらない
  for (const action of fileRowActions(base) ?? []) {
    assert.notEqual(action.kind, "copy-absolute-path", "絶対パスが無い行に出ている");
  }
  // symlink は相対と絶対のコピーだけ。読み取り専用の面も絶対パスを受け取れば両方残す
  assert.deepEqual(
    fileRowActions({ ...base, symlink: true, absolutePath: "/srv/workspace/link" })?.map((action) => action.kind),
    ["copy-path", "copy-absolute-path"],
  );
  assert.deepEqual(fileRowActions({ ...base, readOnly: true, absolutePath: "/srv/workspace/docs" }), [
    copyPath,
    copyAbsolutePath,
  ]);
});

test("描画: 絶対パスを渡した行は ⋯ に パスをコピー → 絶対パスをコピー の順で並べる", () => {
  const html = renderMenu(fileRowActions({ ...base, canRename: true, absolutePath: "/srv/workspace/docs" }) ?? []);
  const copy = html.indexOf(">パスをコピー<");
  const absolute = html.indexOf(">絶対パスをコピー<");
  const download = html.indexOf("ZIP でダウンロード");
  assert.ok(absolute >= 0, "絶対パスをコピーが出ていない");
  assert.ok(
    copy >= 0 && copy < absolute && absolute < download,
    "並びが パスをコピー → 絶対パスをコピー → ダウンロード でない",
  );
  assert.equal((html.match(/role="menuitem"/g) ?? []).length, 5, "絶対パスを足した項目数が違う");
});

function renderMenu(actions: readonly FileRowAction[], name = "docs"): string {
  return renderToStaticMarkup(createElement(RowMenu, { name, actions, onSelect: () => {} }));
}

test("説明の区分と危険の印: 補足は singleColumn で隠し、ZIP の除外は残し、削除だけ danger にする", () => {
  const actions = fileRowActions({ ...base, canRename: true }) ?? [];
  // コピーする字面の基準はラベルで決まる補足なので singleColumn では隠す
  const copy = actions.find((action) => action.kind === "copy-path");
  assert.equal(rowMenuDescriptionKind(copy!), "note");
  // ZIP の除外は実行前に効く (何が入らないか分からないと選べない) ので残す
  const download = actions.find((action) => action.kind === "download");
  assert.equal(rowMenuDescriptionKind(download!), "disclosure");
  // 破壊的な削除は末尾 1 つだけで、他の項目は danger を持たない
  assert.deepEqual(
    actions.map((action) => action.danger === true),
    [false, false, false, true],
    "danger の位置が削除でない",
  );
  // 出せない項目は danger を付けず、出せる項目の後ろに残す
  const excluded = fileRowActions({ ...base, name: "node_modules", canRename: true, excludeNames: ["node_modules"] });
  assert.deepEqual(
    excluded?.map((action) => action.kind),
    ["copy-path", "rename", "delete"],
    "除外名の行の並びが違う",
  );
  assert.equal(excluded?.at(-1)?.danger, true, "削除が末尾の danger でない");
});

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

  // 項目は role=menuitem / tabIndex=-1 (Tab で外へ出る) で、並びは パスをコピー → ダウンロード → リネーム → 削除
  assert.equal((html.match(/role="menuitem"/g) ?? []).length, 4, "項目数が違う");
  assert.equal((html.match(/tabindex="-1"/g) ?? []).length, 4, "項目が Tab の対象になっている");
  const copy = html.indexOf("パスをコピー");
  const download = html.indexOf("ZIP でダウンロード");
  const rename = html.indexOf("名前を変更");
  const remove = html.indexOf("削除");
  assert.ok(
    copy >= 0 && copy < download && download < rename && rename < remove,
    "並びが パスをコピー → ダウンロード → リネーム → 削除 でない",
  );
  // ディレクトリの除外は 2 行目へ移す (メニュー項目の文字ラベルとして出す)。コピーの基準も同じく 2 行目で開示する
  assert.ok(html.includes("ビルド成果物と依存を除く"), "除外の開示がメニュー項目に無い");
  assert.ok(html.includes("ツリーの root からの相対パス"), "コピーする字面の基準がメニュー項目に無い");
  // 削除だけ danger のトーンにする (ラベルとアイコンの 2 か所)
  const items = html.split("<button").filter((part) => part.includes('role="menuitem"'));
  assert.equal(items.length, 4, "項目数が違う");
});

test("描画: symlink は パスをコピー 1 項目、readOnly は パスをコピー (絶対パスがあれば 2 項目) を出す", () => {
  const symlinkRow = renderToStaticMarkup(
    createElement(EntryRowActions, {
      name: "link",
      type: "dir",
      symlink: true,
      canRename: true,
      readOnly: false,
      excludeNames: [],
      copied: false,
      onCopyPath: () => {},
      onCopyAbsolutePath: () => {},
      onRename: () => {},
      onDelete: () => {},
      onDownload: () => {},
    }),
  );
  // ダウンロードも削除も出さない行でも、⋯ とコピーだけは残す
  assert.ok(symlinkRow.includes("パスをコピー"), "symlink の行にパスをコピーが出ていない");
  assert.ok(!symlinkRow.includes("ダウンロード"), "symlink の行にダウンロードが出ている");
  assert.ok(!symlinkRow.includes("削除"), "symlink の行に削除が出ている");
  assert.equal((symlinkRow.match(/role="menuitem"/g) ?? []).length, 1, "symlink の項目数が違う");

  const readOnly = renderToStaticMarkup(
    createElement(EntryRowActions, {
      name: "docs",
      type: "dir",
      canRename: true,
      readOnly: true,
      excludeNames: [],
      copied: false,
      onCopyPath: () => {},
      onCopyAbsolutePath: () => {},
      onRename: () => {},
      onDelete: () => {},
      onDownload: () => {},
    }),
  );
  assert.ok(readOnly.includes("パスをコピー"), "readOnly の行にパスをコピーが出ていない");
  assert.ok(!readOnly.includes("ダウンロード"), "readOnly の行にダウンロードが出ている");
  assert.ok(!readOnly.includes("削除"), "readOnly の行に削除が出ている");
  assert.equal((readOnly.match(/role="menuitem"/g) ?? []).length, 1, "readOnly の項目数が違う");

  const readOnlyAbsolute = renderToStaticMarkup(
    createElement(EntryRowActions, {
      name: "docs",
      type: "dir",
      canRename: true,
      readOnly: true,
      excludeNames: [],
      absolutePath: "/srv/workspace/.agents/skills/demo",
      copied: false,
      onCopyPath: () => {},
      onCopyAbsolutePath: () => {},
      onRename: () => {},
      onDelete: () => {},
      onDownload: () => {},
    }),
  );
  assert.ok(readOnlyAbsolute.includes("絶対パスをコピー"), "readOnly の行に絶対パスをコピーが出ていない");
  assert.equal((readOnlyAbsolute.match(/role="menuitem"/g) ?? []).length, 2, "readOnly の絶対パスを含む項目数が違う");
});

test("描画: パスコピーの失敗は ⋯ ではなく行に 1 行で出し、選択の導線を付けない", () => {
  const none = renderToStaticMarkup(createElement(PathCopyFailure, {}));
  assert.equal(none, "", "失敗していない行に通知が出ている");

  const failure = renderToStaticMarkup(
    createElement(PathCopyFailure, { detail: "textarea: 選択が空 / readonly textarea: execCommand が false" }),
  );
  // 画面に出せないと iOS 実機で原因を切り分けられない。文言は CopyButton と同じにする
  assert.ok(failure.includes('role="alert"'), "行の失敗が live region でない");
  assert.ok(failure.includes("コピーできませんでした"), "CopyButton と同じ失敗の文言でない");
  assert.ok(failure.includes("textarea: 選択が空 / readonly textarea: execCommand が false"), "理由が出ていない");
  // 行のパスは選択状態にできないため、CopyButton の「選択」ボタンは付けない (内訳の文には出得る)
  assert.ok(!failure.includes(">選択</button>"), "選択できない対象に選択の導線が付いている");
});

test("描画: コピー成功の間は ⋯ がチェック + コピーしました になる", () => {
  const html = renderToStaticMarkup(
    createElement(RowMenu, { name: "docs", actions: fileRowActions(base) ?? [], copied: true, onSelect: () => {} }),
  );
  // 項目は選択で消えるため、結果は ⋯ の位置に出す
  assert.ok(html.includes('aria-label="コピーしました"'), "⋯ の読み上げ名がコピーの結果になっていない");
  assert.ok(html.includes('title="コピーしました"'), "⋯ の title がコピーの結果になっていない");
  assert.ok(!html.includes("docs の操作"), "⋯ の読み上げ名が行の名前に戻っていない");
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
  // 長さは ⋯ の項目数 (パスをコピー → ダウンロード → リネーム → 削除) に合わせる
  assert.equal(nextRowMenuIndex(0, 4, "next"), 1);
  assert.equal(nextRowMenuIndex(3, 4, "next"), 3, "末尾で循環した");
  assert.equal(nextRowMenuIndex(1, 4, "previous"), 0);
  assert.equal(nextRowMenuIndex(0, 4, "previous"), 0, "先頭で循環した");
  assert.equal(nextRowMenuIndex(-1, 4, "next"), 0);
  assert.equal(nextRowMenuIndex(-1, 4, "previous"), 3);
  assert.equal(nextRowMenuIndex(0, 0, "next"), -1);
});

test("出し分け: 行の ⋯ にセッション ID のコピーは出さない (作業フォルダ面の帯の専用項目)", () => {
  const rows: (FileRowAction[] | null)[] = [
    fileRowActions(base),
    fileRowActions({ ...base, canRename: true, absolutePath: "/srv/workspace/docs" }),
    fileRowActions({ ...base, type: "file", name: "index.html", canShareSessionRoot: true, canShare: true }),
    fileRowActions({ ...base, readOnly: true, absolutePath: "/srv/workspace/.agents/skills/demo" }),
  ];
  for (const actions of rows) {
    assert.ok(actions !== null);
    // 型 (FileRowActionKind) から外しているので、実行時の出し分けでも混ざらないことを確かめる
    assert.ok(
      !(actions.map((action) => action.kind) as string[]).includes("copy-session-id"),
      "行の ⋯ に帯専用の項目が出ている",
    );
  }
});
