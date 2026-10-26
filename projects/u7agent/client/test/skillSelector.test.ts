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
import {
  MANUAL_ONLY_LABEL,
  NATURAL_INVOCATION_LABEL,
  NATURAL_INVOCATION_OFF_NOTE,
  NATURAL_INVOCATION_ON_NOTE,
} from "../src/components/agent-settings/InvocationModeRow";
import type { FileSkillsState } from "../src/hooks/useFileSkills";
import { RELOAD_ABOVE_NOTE } from "../src/lib/settingsNotes";
import {
  FILE_SKILL_ERROR_PREFIX,
  FILE_SKILL_GROUP_LABEL,
  FILE_SKILL_LOADING_NOTE,
  FILE_SKILL_RELOAD_ARIA_LABEL,
  FILE_SKILL_RELOAD_LABEL,
} from "../src/lib/fileSkills";
import type { BuiltinSkillInfo, FileSkillInfo } from "../src/types";

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
  builtinSkills = [{ name: "builtin", description: "", version: "1" }],
  fileSkills = { status: "ready", skills: [commonSkill("alpha"), commonSkill("beta")] },
  commonSkillNames,
  builtinSkillNames,
  allowNaturalInvocation = true,
}: {
  builtinSkills?: BuiltinSkillInfo[];
  fileSkills?: FileSkillsState;
  commonSkillNames?: string[] | null;
  builtinSkillNames?: string[] | null;
  allowNaturalInvocation?: boolean;
} = {}): string {
  return renderToStaticMarkup(
    createElement(SkillSelector, {
      builtinSkills,
      fileSkills,
      onReloadFileSkills: () => {},
      commonSkillNames,
      onToggleCommonSkill: () => {},
      onShowAllCommonSkills: () => {},
      builtinSkillNames,
      onToggleBuiltinSkill: () => {},
      onShowAllBuiltinSkills: () => {},
      onDisableAllBuiltinSkills: () => {},
      allowNaturalInvocation,
      onToggleNaturalInvocation: () => {},
    }),
  );
}

/** 描画順のチェックボックスの checked。共通スキルだけを見るときは組み込みを空にして呼ぶ */
function checkboxes(html: string): boolean[] {
  return [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((match) => match[0].includes('checked=""'));
}

/** タグを落とした見えている文字。属性の中の語 (aria-label など) を見出しの語と混同しないために使う */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

test("組み込みスキルはチェックで選べて外せる", () => {
  const html = renderSelector({ fileSkills: { status: "ready", skills: [] } });
  const inputs = [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((match) => match[0]);
  assert.equal(inputs.length, 1);
  // 組み込みは操作可能な行 (無効行ではない)
  for (const input of inputs) {
    assert.ok(input.includes('checked=""'));
    assert.ok(!input.includes('disabled=""'));
  }
  assert.ok(html.includes(BUILTIN_SECTION_NOTE));
});

test("共通スキルは未指定なら全チェックで出て、明示リストの OFF を再現する", () => {
  const unspecified = renderSelector({ builtinSkills: [] });
  assert.ok(unspecified.includes(FILE_SKILL_GROUP_LABEL));
  assert.deepEqual(checkboxes(unspecified), [true, true]);
  assert.ok(unspecified.includes("使用 2 / 全 2"));
  // 解除 (null) も未指定と同じ全可視
  assert.deepEqual(checkboxes(renderSelector({ builtinSkills: [], commonSkillNames: null })), [true, true]);

  const explicit = renderSelector({ builtinSkills: [], commonSkillNames: ["alpha"] });
  assert.deepEqual(checkboxes(explicit), [true, false]);
  assert.ok(explicit.includes("使用 1 / 全 2"));
});

test("自然文での発火は使用チェックとは別のスイッチで、OFF なら手動のみと出る", () => {
  const on = renderSelector({ builtinSkills: [] });
  assert.ok(on.includes(NATURAL_INVOCATION_LABEL));
  assert.ok(on.includes(NATURAL_INVOCATION_ON_NOTE));
  assert.equal(on.includes(MANUAL_ONLY_LABEL), false);
  assert.ok(on.includes('aria-checked="true"'), "既定は自然文でも発火する");
  assert.deepEqual(checkboxes(on), [true, true], "使用チェックは変わらない");

  const off = renderSelector({ builtinSkills: [], allowNaturalInvocation: false });
  assert.ok(off.includes(MANUAL_ONLY_LABEL));
  assert.ok(off.includes(NATURAL_INVOCATION_OFF_NOTE));
  assert.ok(off.includes('aria-checked="false"'));
  assert.equal(off.includes(NATURAL_INVOCATION_ON_NOTE), false);
  assert.deepEqual(checkboxes(off), [true, true], "OFF にしても使用中の一覧は残る");
});

test("空の明示リストはすべて OFF で出る", () => {
  const html = renderSelector({ builtinSkills: [], commonSkillNames: [] });
  assert.deepEqual(checkboxes(html), [false, false]);
  assert.ok(html.includes("使用 0 / 全 2"));
});

test("明示リストのときだけ注記と解除の導線を出す", () => {
  const explicit = renderSelector({ builtinSkills: [], commonSkillNames: ["alpha"] });
  assert.ok(explicit.includes(COMMON_SKILL_EXPLICIT_NOTE));
  assert.ok(explicit.includes(COMMON_SKILL_SHOW_ALL_LABEL));
  assert.ok(explicit.includes(COMMON_SKILL_SECTION_NOTE));

  const unspecified = renderSelector({ builtinSkills: [] });
  assert.ok(!unspecified.includes(COMMON_SKILL_EXPLICIT_NOTE));
  assert.ok(!unspecified.includes(COMMON_SKILL_SHOW_ALL_LABEL));
  assert.ok(unspecified.includes(COMMON_SKILL_SECTION_NOTE));
});

test("自動起動なしのスキルも、他の共通スキルと同じく外せる行として出す", () => {
  const html = renderSelector({
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
  const html = renderSelector({ builtinSkills: [], commonSkillNames: ["alpha", "gone"] });
  assert.ok(html.includes("見つかりません"));
  assert.ok(html.includes("gone"));
  assert.deepEqual(checkboxes(html), [true, false]);
});

test("組み込みは未指定なら全チェックで出て、明示リストの OFF を再現する", () => {
  const unspecified = renderSelector({
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
        builtinSkills: [{ name: "alpha", description: "", version: "1" }],
        builtinSkillNames: null,
        fileSkills: { status: "ready", skills: [] },
      }),
    ),
    [true],
  );

  const explicit = renderSelector({
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
    builtinSkills: [
      { name: "alpha", description: "", version: "1" },
      { name: "beta", description: "", version: "1" },
    ],
    fileSkills: { status: "ready", skills: [] },
  });
  assert.ok(allOn.includes(BUILTIN_SKILL_DISABLE_ALL_LABEL));
  assert.ok(!allOn.includes(BUILTIN_SKILL_SHOW_ALL_LABEL));

  const allOff = renderSelector({
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
    builtinSkills: [],
    fileSkills: { status: "error", message: "サンドボックスが設定されていません" },
  });
  assert.deepEqual(labelledButtons(html), [{ ariaLabel: FILE_SKILL_RELOAD_ARIA_LABEL, text: FILE_SKILL_RELOAD_LABEL }]);
  // 取り直しは見出し行 (「スキル」) に置き、本文は理由と上の導線の案内だけにする
  const heading = html.indexOf(">スキル<");
  const button = html.indexOf(FILE_SKILL_RELOAD_ARIA_LABEL);
  const reason = html.indexOf(FILE_SKILL_ERROR_PREFIX);
  assert.ok(heading >= 0 && heading < button && button < reason);
  assert.ok(html.includes(RELOAD_ABOVE_NOTE));

  // 読み込み中と取得済みでは出さない (読み込み中の表示は既存の注記のまま)
  const loading = renderSelector({ builtinSkills: [], fileSkills: { status: "loading" } });
  assert.ok(loading.includes(FILE_SKILL_LOADING_NOTE));
  assert.ok(!loading.includes(RELOAD_ABOVE_NOTE));
  assert.deepEqual(labelledButtons(loading), []);
  const ready = renderSelector({ builtinSkills: [] });
  assert.ok(!ready.includes(RELOAD_ABOVE_NOTE));
  assert.deepEqual(labelledButtons(ready), []);
});

test("定義一覧は件数がゼロのときだけ空状態を出す", () => {
  for (const count of [0, 1]) {
    const html = renderToStaticMarkup(
      createElement(DefinitionList, {
        title: "スキル一覧",
        count,
        add: { label: "追加", onAdd: () => {} },
        emptyLabel: "登録なし",
        children: null,
      }),
    );
    assert.equal(html.includes("登録なし"), count === 0);
  }
});
