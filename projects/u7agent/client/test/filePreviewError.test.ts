import assert from "node:assert/strict";
import test from "node:test";
import { filePreviewErrorHint } from "../src/lib/filePreviewError";

test("プレビューでファイルが見つからない場合は共通スキルの開き方を案内する", () => {
  assert.equal(
    filePreviewErrorHint("Path not found: /workspace/.agents/skills/example/SKILL.md"),
    "共通スキル配下のファイルは 設定 → スキル から開けます。",
  );
});

test("ファイル不存在以外のプレビューエラーには補助文を出さない", () => {
  assert.equal(filePreviewErrorHint("File is too large"), undefined);
  assert.equal(filePreviewErrorHint("HTTP 503"), undefined);
});
