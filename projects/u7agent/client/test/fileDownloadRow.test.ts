// ファイルツリーのダウンロード導線。client に DOM テスト基盤が無いため、行の右端のコンポーネントだけを
// react-dom/server で描画して出し分けを固定し、配線 (check → confirm → <a download> / エラー表示) と
// 文言は lib/archive.ts の純関数 + ソース走査で固定する。
//   1. 通常ファイル / フォルダ行に出て、ダウンロード → リネーム → 削除 の順に並ぶ
//   2. 除外名の行 / symlink 行 / readOnly 面には出ない (スロットは空けて時刻の右端をそろえる)
//   3. フォルダは確認ダイアログ 1 回 (除外があるときだけ) / ファイルは確認なし
//   4. check が先。413 などの理由はツリー内のエラー行に出す (生 JSON を見せない)
//   5. 除外名は app 状態（設定 → アーカイブ の実効値）から prop で受け取る
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { FileDownloadCheck } from "../src/types";

// FileBrowser は api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { EntryRowActions } = await import("../src/components/FileBrowser");
const { archiveConfirmMessage, isArchiveExcludedName } = await import("../src/lib/archive");

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

function renderActions(props: {
  name?: string;
  type?: "file" | "dir";
  symlink?: boolean;
  canRename?: boolean;
  readOnly?: boolean;
  excludeNames?: readonly string[];
}): string {
  return renderToStaticMarkup(
    createElement(EntryRowActions, {
      name: props.name ?? "docs",
      type: props.type ?? "dir",
      symlink: props.symlink,
      canRename: props.canRename ?? false,
      readOnly: props.readOnly ?? false,
      excludeNames: props.excludeNames ?? [],
      onRename: () => {},
      onDelete: () => {},
      onDownload: () => {},
    }),
  );
}

test("描画: ダウンロードは通常ファイル / フォルダ行の左端スロットに出る", () => {
  const dir = renderActions({ canRename: true });
  assert.ok(dir.includes("docs を ZIP でダウンロード"), "フォルダ行に ZIP の導線が出ていない");
  assert.ok(dir.includes("ZIP でダウンロード（ビルド成果物と依存を除く）"), "除外を開示していない");
  assert.ok(dir.includes("docs を削除"));
  assert.ok(
    dir.indexOf("docs を ZIP でダウンロード") < dir.indexOf("docs の名前を変更") &&
      dir.indexOf("docs の名前を変更") < dir.indexOf("docs を削除"),
    "ダウンロード → リネーム → 削除 の順になっていない",
  );

  const file = renderActions({ type: "file" });
  assert.ok(file.includes("docs をダウンロード"), "ファイル行に導線が出ていない");
  assert.ok(file.includes('title="ダウンロード"'), "ファイルのツールチップが違う");
  assert.ok(!file.includes("ZIP"), "ファイル行に ZIP の文言が出ている");
});

test("描画: 除外名 / symlink / readOnly には出さず、スロットだけ残す", () => {
  // 除外名の行はダウンロードを出さず、スロットを空けて時刻の右端をそろえる (削除は残る)
  const excluded = renderActions({ name: "node_modules", excludeNames: ["node_modules", "dist"] });
  assert.ok(!excluded.includes("ダウンロード"), "除外名の行に導線が出ている");
  assert.ok(excluded.includes('class="size-6 shrink-0"'), "除外名の行のスロットが空いていない");
  assert.ok(excluded.includes("を削除"), "除外名の行の削除まで消えている");

  // symlink はダウンロードも削除も出さない (api が 400 で拒否する)。スロットだけ残す
  const symlink = renderActions({ symlink: true, type: "file" });
  assert.ok(!symlink.includes("ダウンロード"), "symlink 行に導線が出ている");
  assert.equal((symlink.match(/class="size-6 shrink-0"/g) ?? []).length, 2, "symlink 行のスロット数が違う");
  // 読み取り専用の面 (スキルのファイルタブ) は行の操作ごと出さない
  for (const props of [{ type: "file" as const }, { canRename: true }, { symlink: true }]) {
    assert.equal(renderActions({ ...props, readOnly: true }), "", `${JSON.stringify(props)} に操作が出ている`);
  }
});

test("確認文言: 除外があるフォルダのときだけ出し、除外名と件数を示す", () => {
  const check: FileDownloadCheck = { kind: "archive", name: "src.zip", bytes: 1536, entries: 3, skipped: ["dist"] };
  const message = archiveConfirmMessage("src", check);
  assert.ok(message.includes("「src」を ZIP でダウンロードします。"), message);
  assert.ok(message.includes("含まれるファイル数 3 件 / 合計サイズ 1.5 KB"), message);
  assert.ok(message.trimEnd().endsWith("除外: dist"), message);

  // 除外は実際に落ちた名前 (サーバーの check の skipped) をそのまま出す
  const multi = archiveConfirmMessage("src", { ...check, skipped: ["node_modules", ".git"] });
  assert.ok(multi.includes("除外: node_modules, .git"), multi);

  assert.ok(isArchiveExcludedName("dist", ["dist"]));
  assert.ok(!isArchiveExcludedName("dist-2", ["dist"]));
  assert.ok(!isArchiveExcludedName("dist", []));
});

test("ダウンロードは check を通してから開始し、エラーはツリー内に出す", () => {
  const source = read("src/components/FileBrowser.tsx");
  assert.ok(source.includes("await getFileDownloadCheck(fetchPath)"), "check を通していない");
  assert.ok(
    source.indexOf("await getFileDownloadCheck(fetchPath)") < source.indexOf("startArchiveDownload("),
    "開始が check より先になっている",
  );
  // 確認は除外があるときだけ (ディレクトリ行)
  assert.ok(
    source.includes(
      'if (type === "dir" && check.skipped.length > 0 && !window.confirm(archiveConfirmMessage(name, check)))',
    ),
    "確認の条件が違う",
  );
  assert.ok(source.includes("startArchiveDownload(fileDownloadUrl(fetchPath), check.name)"));
  // 失敗は削除 / リネームと同じく親ディレクトリの行に出す (生 JSON をブラウザに見せない)
  assert.ok(
    source.includes("applyFileTreeError(prev, fileTreeParentPath(path), errorText(error))"),
    "失敗の表示がツリー内でない",
  );
  assert.ok(source.includes("downloadingRef.current.has(path)"), "同じ行の二重送信を弾いていない");
  // ページ遷移しない (本文を fetch して JSON に載せない)
  assert.ok(source.includes("fileDownloadUrl(fetchPath)"), "URL の組み立てが無い");
  assert.ok(!source.includes("fetch(fileDownloadUrl"), "本文を fetch している");
});

test("除外名は prop で受け取り、FileBrowser は health を取りに行かない", () => {
  const source = read("src/components/FileBrowser.tsx");
  // 取得元は app 状態（設定ストアの実効値）。保存の直後に再 mount なしで追随させるため health は使わない
  assert.ok(!source.includes("getHealth"), "FileBrowser が health を取りに行っている");
  assert.ok(!source.includes("health.archive?.excludeNames"), "実効値の出所が health のままである");
  assert.ok(source.includes("excludeNames: readonly string[]"), "excludeNames prop を受けていない");
  assert.ok(source.includes("excludeNames={excludeNames}"), "行へ渡していない");
  assert.ok(read("src/lib/archive.ts").includes("excludeNames.includes(name)"), "除外の判定が純関数でない");
});
