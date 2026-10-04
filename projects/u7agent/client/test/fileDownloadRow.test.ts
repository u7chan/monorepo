import assert from "node:assert/strict";

import test from "node:test";
import { archiveConfirmRequest, isArchiveExcludedName } from "../src/lib/archive";
import { fileRowActions } from "../src/lib/fileRowMenu";
import type { FileDownloadCheck } from "../src/types";

const base = {
  name: "src",
  type: "dir" as const,
  canRename: false,
  readOnly: false,
  excludeNames: [] as readonly string[],
};

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
  const request = archiveConfirmRequest("src", check);
  // フォルダ名は clamp される独立した行へ出し、本文には入れない
  assert.deepEqual(request.subject, { label: "ダウンロードするフォルダ", value: "src" });
  assert.deepEqual(request.body, ["含まれるファイル数 3 件 / 合計サイズ 1.5 KB", "除外: dist"]);
  assert.equal(request.confirmLabel, "ダウンロードする");

  // 除外は実際に落ちた名前 (サーバーの check の skipped) をそのまま出す
  const multi = archiveConfirmRequest("src", { ...check, skipped: ["node_modules", ".git"] });
  assert.equal(multi.body?.[1], "除外: node_modules, .git");

  assert.ok(isArchiveExcludedName("dist", ["dist"]));
  assert.ok(!isArchiveExcludedName("dist-2", ["dist"]));
  assert.ok(!isArchiveExcludedName("dist", []));
});
