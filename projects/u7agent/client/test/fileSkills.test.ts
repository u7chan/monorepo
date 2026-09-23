// スキル一覧の表示用導出 (グループ分け / 重複警告 / 上書き表示) を DOM なしで固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILTIN_SKILL_GROUP_LABEL,
  FILE_SKILL_GROUP_LABEL,
  FILE_SKILL_PANEL_HEADING,
  FILE_SKILL_RELOAD_ARIA_LABEL,
  FILE_SKILL_RELOAD_LABEL,
  FILE_SKILL_SCOPE_LABEL,
  FILE_SKILL_SECTION_LABEL,
  fileSkillWarning,
  groupFileSkills,
} from "../src/lib/fileSkills";
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
    overridden: false,
    ...overrides,
  };
}

function builtinSkill(overrides: Partial<FileSkillInfo> = {}): FileSkillInfo {
  return fileSkill({
    name: "skill-creator",
    path: "/workspace/.u7agent/builtin-skills/skill-creator/SKILL.md",
    relativePath: ".u7agent/builtin-skills/skill-creator/SKILL.md",
    scope: "builtin",
    body: "---\nname: skill-creator\n---\n本文\n",
    version: "1",
    ...overrides,
  });
}

test("重複が無いスキルには警告を出さない", () => {
  assert.equal(fileSkillWarning(fileSkill()), null);
});

test("同名のスキルがあるときは有効な側と読み込まれない側を示す", () => {
  const warning = fileSkillWarning(
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

test("組み込みは上書きされているときだけ警告を出す", () => {
  assert.equal(fileSkillWarning(builtinSkill()), null);
  assert.equal(
    fileSkillWarning(builtinSkill({ overridden: true })),
    "上書きされています（同名の共通スキルが優先されます）",
  );
});

test("グループ分けは組み込みを共通スキルから分ける", () => {
  const common = fileSkill();
  const builtin = builtinSkill();
  const groups = groupFileSkills([common, builtin, fileSkill({ scope: "project" })]);
  assert.deepEqual(
    groups.common.map((skill) => [skill.scope, skill.name]),
    [
      ["user", "alpha"],
      ["project", "alpha"],
    ],
  );
  assert.deepEqual(
    groups.builtin.map((skill) => skill.name),
    ["skill-creator"],
  );
});

test("スコープの表示名は 3 種類そろっている", () => {
  assert.deepEqual(FILE_SKILL_SCOPE_LABEL, { user: "共通", project: "プロジェクト", builtin: "組み込み" });
});

test("本文ビューの見出しはグループ名と同じ 3 種類そろっている", () => {
  assert.deepEqual(FILE_SKILL_PANEL_HEADING, {
    user: "共通スキル",
    project: "プロジェクトスキル",
    builtin: "組み込みスキル",
  });
});

test("読み取り専用の断りはブロックの見出しにだけ出し、グループはスコープ名だけにする", () => {
  assert.ok(FILE_SKILL_SECTION_LABEL.includes("読み取り専用"));
  for (const label of [FILE_SKILL_GROUP_LABEL, BUILTIN_SKILL_GROUP_LABEL]) {
    assert.ok(!label.includes("読み取り専用"), `${label} が読み取り専用を繰り返している`);
  }
});

test("再読み込みの読み上げ名は視覚ラベルを含み、更新される 2 つのグループを挙げる", () => {
  // 視覚ラベルを名前が含まないと、音声入力で「再読み込み」と言っても押せない (WCAG 2.5.3)
  assert.ok(FILE_SKILL_RELOAD_ARIA_LABEL.includes(FILE_SKILL_RELOAD_LABEL));
  assert.ok(FILE_SKILL_RELOAD_ARIA_LABEL.includes(FILE_SKILL_GROUP_LABEL));
  assert.ok(FILE_SKILL_RELOAD_ARIA_LABEL.includes(BUILTIN_SKILL_GROUP_LABEL));
});
