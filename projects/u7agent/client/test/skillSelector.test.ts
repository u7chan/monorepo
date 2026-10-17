import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import {
  BUILTIN_SECTION_NOTE,
  BUILTIN_SKILL_DISABLE_ALL_LABEL,
  BUILTIN_SKILL_EXPLICIT_NOTE,
  BUILTIN_SKILL_SHOW_ALL_LABEL,
  COMMON_SKILL_EXPLICIT_NOTE,
  COMMON_SKILL_SECTION_NOTE,
  COMMON_SKILL_SHOW_ALL_LABEL,
  SkillSelector,
} from "../src/components/agent-settings/SkillSelector";
import { DefinitionList } from "../src/components/DefinitionList";
import type { FileSkillsState } from "../src/hooks/useFileSkills";
import { RELOAD_ABOVE_NOTE } from "../src/lib/settingsNotes";
import {
  FILE_SKILL_ERROR_PREFIX,
  FILE_SKILL_GROUP_LABEL,
  FILE_SKILL_LOADING_NOTE,
  FILE_SKILL_RELOAD_ARIA_LABEL,
  FILE_SKILL_RELOAD_LABEL,
} from "../src/lib/fileSkills";
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
  builtinSkills = [{ name: "builtin", description: "", version: "1" }],
  fileSkills = { status: "ready", skills: [commonSkill("alpha"), commonSkill("beta")] },
  commonSkillNames,
  builtinSkillNames,
}: {
  skills?: SkillDef[];
  builtinSkills?: BuiltinSkillInfo[];
  fileSkills?: FileSkillsState;
  commonSkillNames?: string[] | null;
  builtinSkillNames?: string[] | null;
} = {}): string {
  return renderToStaticMarkup(
    createElement(SkillSelector, {
      skills,
      builtinSkills,
      selectedIds: skills.map((skill) => skill.id),
      onToggle: () => {},
      fileSkills,
      onReloadFileSkills: () => {},
      commonSkillNames,
      onToggleCommonSkill: () => {},
      onShowAllCommonSkills: () => {},
      builtinSkillNames,
      onToggleBuiltinSkill: () => {},
      onShowAllBuiltinSkills: () => {},
      onDisableAllBuiltinSkills: () => {},
    }),
  );
}

/** 描画順のチェックボックスの checked。共通スキルだけを見るときはカタログと組み込みを空にして呼ぶ */
function checkboxes(html: string): boolean[] {
  return [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((match) => match[0].includes('checked=""'));
}

/** タグを落とした見えている文字。属性の中の語 (aria-label など) を見出しの語と混同しないために使う */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

test("カタログスキルも組み込みも、同じチェックで選べて外せる", () => {
  const html = renderSelector({ fileSkills: { status: "ready", skills: [] } });
  const inputs = [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((match) => match[0]);
  assert.equal(inputs.length, 2);
  // 組み込みはカタログと同じ操作可能な行 (無効行ではない)
  for (const input of inputs) {
    assert.ok(input.includes('checked=""'));
    assert.ok(!input.includes('disabled=""'));
  }
  assert.ok(html.includes(BUILTIN_SECTION_NOTE));
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

test("組み込みは未指定なら全チェックで出て、明示リストの OFF を再現する", () => {
  const unspecified = renderSelector({
    skills: [],
    builtinSkills: [
      { name: "alpha", description: "", version: "1" },
      { name: "beta", description: "", version: "1" },
    ],
    fileSkills: { status: "ready", skills: [] },
  });
  assert.deepEqual(checkboxes(unspecified), [true, true]);
  assert.ok(unspecified.includes("使用 2 / 全 2"));
  // 解除 (null) も未指定と同じ全部 ON
  assert.deepEqual(
    checkboxes(
      renderSelector({
        skills: [],
        builtinSkills: [{ name: "alpha", description: "", version: "1" }],
        builtinSkillNames: null,
        fileSkills: { status: "ready", skills: [] },
      }),
    ),
    [true],
  );

  const explicit = renderSelector({
    skills: [],
    builtinSkills: [
      { name: "alpha", description: "", version: "1" },
      { name: "beta", description: "", version: "1" },
    ],
    builtinSkillNames: ["alpha"],
    fileSkills: { status: "ready", skills: [] },
  });
  assert.deepEqual(checkboxes(explicit), [true, false]);
  assert.ok(explicit.includes("使用 1 / 全 2"));
});

test("空の組み込み明示リストはすべて OFF で出る", () => {
  const html = renderSelector({
    skills: [],
    builtinSkills: [
      { name: "alpha", description: "", version: "1" },
      { name: "beta", description: "", version: "1" },
    ],
    builtinSkillNames: [],
    fileSkills: { status: "ready", skills: [] },
  });
  assert.deepEqual(checkboxes(html), [false, false]);
  assert.ok(html.includes("使用 0 / 全 2"));
});

test("組み込みの全外しと使用への復帰は、対象があるときだけ導線を出す", () => {
  const allOn = renderSelector({
    skills: [],
    builtinSkills: [
      { name: "alpha", description: "", version: "1" },
      { name: "beta", description: "", version: "1" },
    ],
    fileSkills: { status: "ready", skills: [] },
  });
  assert.ok(allOn.includes(BUILTIN_SKILL_DISABLE_ALL_LABEL));
  assert.ok(!allOn.includes(BUILTIN_SKILL_SHOW_ALL_LABEL));

  const allOff = renderSelector({
    skills: [],
    builtinSkills: [
      { name: "alpha", description: "", version: "1" },
      { name: "beta", description: "", version: "1" },
    ],
    builtinSkillNames: [],
    fileSkills: { status: "ready", skills: [] },
  });
  assert.ok(!allOff.includes(BUILTIN_SKILL_DISABLE_ALL_LABEL));
  assert.ok(allOff.includes(BUILTIN_SKILL_SHOW_ALL_LABEL));
  assert.ok(allOff.includes(BUILTIN_SKILL_EXPLICIT_NOTE));

  const partial = renderSelector({
    skills: [],
    builtinSkills: [
      { name: "alpha", description: "", version: "1" },
      { name: "beta", description: "", version: "1" },
    ],
    builtinSkillNames: ["alpha"],
    fileSkills: { status: "ready", skills: [] },
  });
  assert.ok(partial.includes(BUILTIN_SKILL_DISABLE_ALL_LABEL));
  assert.ok(partial.includes(BUILTIN_SKILL_SHOW_ALL_LABEL));
});

test("組み込みの一覧に無い保存名は落とさず、見つからない旨を出す", () => {
  const html = renderSelector({
    skills: [],
    builtinSkills: [{ name: "alpha", description: "", version: "1" }],
    builtinSkillNames: ["alpha", "gone"],
    fileSkills: { status: "ready", skills: [] },
  });
  assert.ok(html.includes("見つかりません"));
  assert.ok(html.includes("gone"));
  assert.ok(html.includes("同梱物が入れ替わっても"));
  assert.deepEqual(checkboxes(html), [true]);
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
  // 再読み込みの aria-label はグループ名を含むので、見出しの有無は本文の文字で見る
  assert.ok(!visibleText(html).includes(FILE_SKILL_GROUP_LABEL));
  assert.deepEqual(checkboxes(html), []);
});

/** aria-label 付きのボタン (共通スキルの再読み込みはこれだけ)。ラベルは中身から取る */
function labelledButtons(html: string): { ariaLabel: string; text: string }[] {
  return [...html.matchAll(/<button[^>]*aria-label="([^"]*)"[^>]*>([\s\S]*?)<\/button>/g)].map((match) => ({
    ariaLabel: match[1],
    text: match[2].replace(/<[^>]*>/g, ""),
  }));
}

test("取得失敗のときだけ、見出し行に再読み込みの導線を出す", () => {
  const html = renderSelector({
    skills: [],
    builtinSkills: [],
    fileSkills: { status: "error", message: "サンドボックスが設定されていません" },
  });
  assert.deepEqual(labelledButtons(html), [{ ariaLabel: FILE_SKILL_RELOAD_ARIA_LABEL, text: FILE_SKILL_RELOAD_LABEL }]);
  // 取り直しは見出し行 (「スキル 割り当て中 n / 全 m」) に置き、本文は理由と上の導線の案内だけにする
  const heading = html.indexOf("割り当て中");
  const button = html.indexOf(FILE_SKILL_RELOAD_ARIA_LABEL);
  const reason = html.indexOf(FILE_SKILL_ERROR_PREFIX);
  assert.ok(heading >= 0 && heading < button && button < reason);
  assert.ok(html.includes(RELOAD_ABOVE_NOTE));

  // 読み込み中と取得済みでは出さない (読み込み中の表示は既存の注記のまま)
  const loading = renderSelector({ skills: [], builtinSkills: [], fileSkills: { status: "loading" } });
  assert.ok(loading.includes(FILE_SKILL_LOADING_NOTE));
  assert.ok(!loading.includes(RELOAD_ABOVE_NOTE));
  assert.deepEqual(labelledButtons(loading), []);
  const ready = renderSelector({ skills: [], builtinSkills: [] });
  assert.ok(!ready.includes(RELOAD_ABOVE_NOTE));
  assert.deepEqual(labelledButtons(ready), []);
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
