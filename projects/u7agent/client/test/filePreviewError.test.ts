import assert from "node:assert/strict";
import test from "node:test";
import { filePreviewErrorHint } from "../src/lib/filePreviewError";

const HINT = "共通スキル配下のファイルは 設定 → スキル から開けます。";

test("共通スキル配下のファイルが見つからない場合は開き方を案内する", () => {
  assert.equal(
    filePreviewErrorHint(
      "Path not found: /workspace/.agents/skills/example/SKILL.md",
      ".agents/skills/example/SKILL.md",
    ),
    HINT,
  );
  // 設定 → ファイル (ワークスペース root) のツリーから開いた場合も、共通スキルの案内は使える
  assert.equal(
    filePreviewErrorHint(
      "Path not found: /workspace/.agents/skills/example/assets/a.png",
      ".agents/skills/example/assets/a.png",
    ),
    HINT,
  );
});

test("作業フォルダ側の参照には共通スキルの案内を出さない", () => {
  // 共有スキルと同名のパスでも、面の座標が違えば別のファイル (案内が誤らないようにする)
  assert.equal(filePreviewErrorHint("Path not found: /workspace/proj/AGENTS.md", "proj/AGENTS.md"), undefined);
  assert.equal(
    filePreviewErrorHint(
      "Path not found: /workspace/proj/.agents/skills/example/SKILL.md",
      "proj/.agents/skills/example/SKILL.md",
    ),
    undefined,
  );
  // 接頭辞が似ているだけの置き場は共通スキルではない
  assert.equal(
    filePreviewErrorHint(
      "Path not found: /workspace/.agents/skillsx/example/SKILL.md",
      ".agents/skillsx/example/SKILL.md",
    ),
    undefined,
  );
});

test("ファイル不存在以外のプレビューエラーには補助文を出さない", () => {
  assert.equal(filePreviewErrorHint("File is too large", ".agents/skills/example/SKILL.md"), undefined);
  assert.equal(filePreviewErrorHint("HTTP 503", ".agents/skills/example/SKILL.md"), undefined);
});
