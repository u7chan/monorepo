// ファイルツリーのダウンロード導線。行の右端の ⋯ メニューの出し分けと文言は lib/fileRowMenu.ts の
// 純関数が正で、ここではダウンロード固有の条件 / 文言と、配線 (check → confirm → <a download> / エラー表示)、
// 除外名の出所を固定する (描画の属性は fileRowMenu.test.ts)。
//   1. 通常ファイル / フォルダ行に「ダウンロード」「ZIP でダウンロード」として出る
//   2. 除外名の行 / symlink 行 / readOnly 面には出ない (フォルダの除外開示はメニューの 2 行目)
//   3. フォルダは確認ダイアログ 1 回 (除外があるときだけ) / ファイルは確認なし
//   4. check が先。413 などの理由はツリー内のエラー行に出す (生 JSON を見せない)
//   5. 除外名は app 状態（設定 → アーカイブ の実効値）から prop で受け取る
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { archiveConfirmMessage, isArchiveExcludedName } from "../src/lib/archive";
import { fileRowActions } from "../src/lib/fileRowMenu";
import type { FileDownloadCheck } from "../src/types";

const base = {
  name: "src",
  type: "dir" as const,
  canRename: false,
  readOnly: false,
  excludeNames: [] as readonly string[],
};

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

test("ダウンロード: フォルダは ZIP のラベルと除外の開示、ファイルは「ダウンロード」", () => {
  const dir = fileRowActions(base) ?? [];
  assert.deepEqual(
    dir.find((action) => action.kind === "download"),
    {
      kind: "download",
      label: "ZIP でダウンロード",
      description: "ビルド成果物と依存を除く",
    },
  );

  const file = fileRowActions({ ...base, type: "file" }) ?? [];
  assert.deepEqual(
    file.find((action) => action.kind === "download"),
    { kind: "download", label: "ダウンロード" },
  );
  assert.ok(!file.some((action) => action.label.includes("ZIP")), "ファイルに ZIP の文言が出ている");
});

test("ダウンロード: 除外名 / symlink / readOnly には出さない", () => {
  // 除外名の行は押した直後に 400 になるため出さない (削除とリネームは残る)
  const excluded = fileRowActions({ ...base, name: "node_modules", excludeNames: ["node_modules", "dist"] }) ?? [];
  assert.ok(!excluded.some((action) => action.kind === "download"), "除外名の行に導線が出ている");
  assert.ok(
    excluded.some((action) => action.kind === "delete"),
    "除外名の行の削除まで消えている",
  );

  // symlink はダウンロードも削除も出さない (api が 400 で拒否する)。項目 0 で空きスロットになる
  for (const type of ["file", "dir"] as const) {
    assert.deepEqual(fileRowActions({ ...base, type, symlink: true }), [], type);
  }
  // 読み取り専用の面 (スキルのファイルタブ) は行の操作ごと出さない
  assert.equal(fileRowActions({ ...base, readOnly: true }), null);
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
