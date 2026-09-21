// 共通スキル一覧の表示用導出 (重複警告の文言) を DOM なしで固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { fileSkillDuplicateWarning } from "../src/lib/fileSkills";
import type { FileSkillInfo } from "../src/types";

function fileSkill(overrides: Partial<FileSkillInfo> = {}): FileSkillInfo {
  return {
    name: "alpha",
    description: "アルファの説明",
    path: "/workspace/.agents/skills/alpha/SKILL.md",
    relativePath: ".agents/skills/alpha/SKILL.md",
    scope: "user",
    disableModelInvocation: false,
    shadowed: [],
    ...overrides,
  };
}

test("重複が無いスキルには警告を出さない", () => {
  assert.equal(fileSkillDuplicateWarning(fileSkill()), null);
});

test("同名のスキルがあるときは有効な側と読み込まれない側を示す", () => {
  const warning = fileSkillDuplicateWarning(
    fileSkill({
      shadowed: [
        { path: "/workspace/.agents/skills/shared/SKILL.md", relativePath: ".agents/skills/shared/SKILL.md" },
        { path: "/workspace/.agents/skills/b/SKILL.md", relativePath: ".agents/skills/b/SKILL.md" },
      ],
    }),
  );
  assert.equal(
    warning,
    "同名のスキルが 3 件あります。有効: .agents/skills/alpha/SKILL.md / 読み込まれない: .agents/skills/shared/SKILL.md, .agents/skills/b/SKILL.md",
  );
});
