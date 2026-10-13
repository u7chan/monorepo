import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import {
  COMMON_SKILL_EXPLICIT_NOTE,
  COMMON_SKILL_SECTION_NOTE,
  COMMON_SKILL_SHOW_ALL_LABEL,
  SkillSelector,
} from "../src/components/agent-settings/SkillSelector";
import { DefinitionList } from "../src/components/DefinitionList";
import type { FileSkillsState } from "../src/hooks/useFileSkills";
import { FILE_SKILL_ERROR_PREFIX, FILE_SKILL_GROUP_LABEL } from "../src/lib/fileSkills";
import type { BuiltinSkillInfo, FileSkillInfo, SkillDef } from "../src/types";

function commonSkill(name: string, overrides: Partial<FileSkillInfo> = {}): FileSkillInfo {
  return {
    name,
    description: `${name} の説明`,
    path: `/workspace/.agents/skills/${name}/SKILL.md`,
    relativePath: `.agents/skills/${name}/SKILL.md`,
    scope: "user",
    disableModelInvocation: false,
    shadowed: [],
    overridden: false,
    ...overrides,
  };
}

function renderSelector({
  skills = [{ id: "catalog", name: "Catalog", description: "", body: "本文" }],
  builtinSkills = [{ name: "builtin", description: "" }],
  fileSkills = { status: "ready", skills: [commonSkill("alpha"), commonSkill("beta")] },
  commonSkillNames,
}: {
  skills?: SkillDef[];
  builtinSkills?: BuiltinSkillInfo[];
  fileSkills?: FileSkillsState;
  commonSkillNames?: string[] | null;
} = {}): string {
  return renderToStaticMarkup(
    createElement(SkillSelector, {
      skills,
      builtinSkills,
      selectedIds: skills.map((skill) => skill.id),
      onToggle: () => {},
      fileSkills,
      commonSkillNames,
      onToggleCommonSkill: () => {},
      onShowAllCommonSkills: () => {},
    }),
  );
}

/** 描画順のチェックボックスの checked。共通スキルだけを見るときはカタログと組み込みを空にして呼ぶ */
function checkboxes(html: string): boolean[] {
  return [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((match) => match[0].includes('checked=""'));
}

test("カタログスキルは選択でき、組み込みはチェック済みの無効行として出す", () => {
  const html = renderSelector({ fileSkills: { status: "ready", skills: [] } });
  const inputs = [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((match) => match[0]);
  assert.equal(inputs.length, 2);
  assert.ok(inputs[0].includes('checked=""'));
  assert.ok(!inputs[0].includes('disabled=""'));
  assert.ok(inputs[1].includes('checked=""'));
  assert.ok(inputs[1].includes('disabled=""'));
  assert.ok(html.includes("割り当てを外すことはできません"));
});

test("共通スキルは未指定なら全チェックで出て、明示リストの OFF を再現する", () => {
  const unspecified = renderSelector({ skills: [], builtinSkills: [] });
  assert.ok(unspecified.includes(FILE_SKILL_GROUP_LABEL));
  assert.deepEqual(checkboxes(unspecified), [true, true]);
  assert.ok(unspecified.includes("使用 2 / 全 2"));
  // 解除 (null) も未指定と同じ全可視
  assert.deepEqual(checkboxes(renderSelector({ skills: [], builtinSkills: [], commonSkillNames: null })), [true, true]);

  const explicit = renderSelector({ skills: [], builtinSkills: [], commonSkillNames: ["alpha"] });
  assert.deepEqual(checkboxes(explicit), [true, false]);
  assert.ok(explicit.includes("使用 1 / 全 2"));
});

test("空の明示リストはすべて OFF で出る", () => {
  const html = renderSelector({ skills: [], builtinSkills: [], commonSkillNames: [] });
  assert.deepEqual(checkboxes(html), [false, false]);
  assert.ok(html.includes("使用 0 / 全 2"));
});

test("明示リストのときだけ注記と解除の導線を出す", () => {
  const explicit = renderSelector({ skills: [], builtinSkills: [], commonSkillNames: ["alpha"] });
  assert.ok(explicit.includes(COMMON_SKILL_EXPLICIT_NOTE));
  assert.ok(explicit.includes(COMMON_SKILL_SHOW_ALL_LABEL));
  assert.ok(explicit.includes(COMMON_SKILL_SECTION_NOTE));

  const unspecified = renderSelector({ skills: [], builtinSkills: [] });
  assert.ok(!unspecified.includes(COMMON_SKILL_EXPLICIT_NOTE));
  assert.ok(!unspecified.includes(COMMON_SKILL_SHOW_ALL_LABEL));
  assert.ok(unspecified.includes(COMMON_SKILL_SECTION_NOTE));
});

test("自動起動なしのスキルも、他の共通スキルと同じく外せる行として出す", () => {
  const html = renderSelector({
    skills: [],
    builtinSkills: [],
    fileSkills: {
      status: "ready",
      skills: [commonSkill("alpha"), commonSkill("beta", { disableModelInvocation: true })],
    },
  });
  assert.ok(html.includes("自動起動なし"));
  assert.deepEqual(checkboxes(html), [true, true]);
});

test("一覧に無い保存名は落とさず、見つからない旨を出す", () => {
  const html = renderSelector({ skills: [], builtinSkills: [], commonSkillNames: ["alpha", "gone"] });
  assert.ok(html.includes("見つかりません"));
  assert.ok(html.includes("gone"));
  assert.deepEqual(checkboxes(html), [true, false]);
});

test("取得失敗時は共通スキルの欄を出さず、理由を出す", () => {
  const html = renderSelector({
    skills: [],
    builtinSkills: [],
    commonSkillNames: [],
    fileSkills: { status: "error", message: "サンドボックスが設定されていません" },
  });
  assert.ok(html.includes(FILE_SKILL_ERROR_PREFIX));
  assert.ok(html.includes("サンドボックスが設定されていません"));
  assert.ok(!html.includes(FILE_SKILL_GROUP_LABEL));
  assert.deepEqual(checkboxes(html), []);
});

test("定義一覧は件数がゼロのときだけ空状態を出す", () => {
  for (const count of [0, 1]) {
    const html = renderToStaticMarkup(
      createElement(DefinitionList, {
        title: "スキル一覧",
        count,
        addLabel: "追加",
        emptyLabel: "登録なし",
        onAdd: () => {},
        children: null,
      }),
    );
    assert.equal(html.includes("登録なし"), count === 0);
  }
});
