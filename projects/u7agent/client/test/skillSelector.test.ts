// エージェント編集のスキルタブ。行は行全体が 1 つの role="switch" で、組み込み → 共通の順に並ぶ。
// 検索は表示だけを絞り、切替と一括操作の母集合は未絞込の visible 行のままにする。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import {
  BUILTIN_SECTION_LABEL,
  BUILTIN_SECTION_NOTE,
  BUILTIN_SKILL_EXPLICIT_NOTE,
  COMMON_SKILL_EXPLICIT_NOTE,
  COMMON_SKILL_SECTION_NOTE,
  SkillSelector,
} from "../src/components/agent-settings/SkillSelector";
import {
  MANUAL_ONLY_LABEL,
  NATURAL_INVOCATION_LABEL,
  NATURAL_INVOCATION_OFF_NOTE,
  NATURAL_INVOCATION_ON_NOTE,
} from "../src/components/agent-settings/InvocationModeRow";
import { ALLOWLIST_DISABLE_GROUP_LABEL, ALLOWLIST_RESET_LABEL } from "../src/lib/allowlistText";
import type { FileSkillsState } from "../src/hooks/useFileSkills";
import { RELOAD_ABOVE_NOTE } from "../src/lib/settingsNotes";
import {
  COMMON_SKILL_SECTION_LABEL,
  FILE_SKILL_ERROR_PREFIX,
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

const TWO_BUILTINS: BuiltinSkillInfo[] = [
  { name: "browser", description: "ブラウザ", version: "1" },
  { name: "serve", description: "サーバー", version: "2" },
];

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
      builtinSkillNames,
      onToggleCommonSkill: () => {},
      onToggleBuiltinSkill: () => {},
      onDisableCommonSkills: () => {},
      onDisableBuiltinSkills: () => {},
      onResetSkills: () => {},
      allowNaturalInvocation,
      onToggleNaturalInvocation: () => {},
    }),
  );
}

/** スキル行のスイッチだけを描画順に取る (自然文の発火は別のスイッチなので読み上げ名で分ける) */
function skillSwitches(html: string): { label: string; checked: boolean }[] {
  return [...html.matchAll(/<button[^>]*role="switch"[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => tag.includes("を使う"))
    .map((tag) => ({
      label: tag.match(/aria-label="([^"]*)"/)?.[1] ?? "",
      checked: tag.includes('aria-checked="true"'),
    }));
}

test("組み込みを先頭に、共通を後に並べる", () => {
  const html = renderSelector({
    builtinSkills: TWO_BUILTINS,
    fileSkills: { status: "ready", skills: [commonSkill("alpha")] },
  });
  assert.deepEqual(
    skillSwitches(html).map((row) => row.label),
    ["browser を使う", "serve を使う", "alpha を使う"],
  );
  assert.ok(html.indexOf(BUILTIN_SECTION_LABEL) < html.indexOf(COMMON_SKILL_SECTION_LABEL));
});

test("未指定と解除は全部 ON、明示リストは選んだ名前だけ ON、空の明示リストはすべて OFF", () => {
  const allOn = renderSelector({ fileSkills: { status: "ready", skills: [] } });
  assert.deepEqual(skillSwitches(allOn), [{ label: "builtin を使う", checked: true }]);
  assert.deepEqual(
    skillSwitches(renderSelector({ builtinSkillNames: null, fileSkills: { status: "ready", skills: [] } })),
    [{ label: "builtin を使う", checked: true }],
  );
  assert.deepEqual(
    skillSwitches(renderSelector({ builtinSkillNames: [], fileSkills: { status: "ready", skills: [] } })),
    [{ label: "builtin を使う", checked: false }],
  );
});

test("件数は検索で絞る前の visible 行で出し、グループごとにも出す", () => {
  const html = renderSelector({
    builtinSkills: TWO_BUILTINS,
    fileSkills: { status: "ready", skills: [commonSkill("alpha"), commonSkill("beta")] },
    commonSkillNames: ["alpha"],
    builtinSkillNames: ["browser"],
  });
  // タブ上部は割当の合計 (組み込み 1 + 共通 1) / 全 4
  assert.ok(html.includes("使用 2 / 全 4"));
  assert.ok(html.includes("使用 1 / 全 2"), "グループごとの件数が無い");
  assert.ok(html.includes("既定から変更あり"));
});

test("既定から変えていなければ変更の表示も「既定に戻す」も出さない", () => {
  const html = renderSelector({ fileSkills: { status: "ready", skills: [] } });
  assert.ok(html.includes("既定のまま"));
  assert.equal(html.includes(ALLOWLIST_RESET_LABEL), false);
});

test("明示リストのときだけ「すべて既定に戻す」と明示リストの注記を出す", () => {
  const explicit = renderSelector({ builtinSkills: [], commonSkillNames: ["alpha"] });
  assert.ok(explicit.includes(ALLOWLIST_RESET_LABEL));
  assert.ok(explicit.includes(COMMON_SKILL_EXPLICIT_NOTE));
  assert.ok(!explicit.includes(BUILTIN_SKILL_EXPLICIT_NOTE), "組み込みは未指定なので注記を出さない");

  const builtinExplicit = renderSelector({
    builtinSkillNames: ["builtin"],
    fileSkills: { status: "ready", skills: [] },
  });
  assert.ok(builtinExplicit.includes(BUILTIN_SKILL_EXPLICIT_NOTE));
});

test("グループの「すべて外す」は使用中の行があるときだけ出す", () => {
  const allOn = renderSelector({ builtinSkills: TWO_BUILTINS, fileSkills: { status: "ready", skills: [] } });
  assert.ok(allOn.includes(ALLOWLIST_DISABLE_GROUP_LABEL));

  const allOff = renderSelector({
    builtinSkills: TWO_BUILTINS,
    builtinSkillNames: [],
    fileSkills: { status: "ready", skills: [] },
  });
  assert.equal(allOff.includes(ALLOWLIST_DISABLE_GROUP_LABEL), false);
});

test("自然文での発火は使用スイッチとは別のスイッチで、OFF なら手動のみと出る", () => {
  const on = renderSelector({ builtinSkills: [] });
  assert.ok(on.includes(NATURAL_INVOCATION_LABEL));
  assert.ok(on.includes(NATURAL_INVOCATION_ON_NOTE));
  assert.equal(on.includes(MANUAL_ONLY_LABEL), false);
  // 起動モードのスイッチは文字ラベルを持つ (使用スイッチとは aria-checked の位置で区別できる)
  assert.match(on, /<button[^>]*role="switch"[^>]*aria-checked="true"[^>]*>[\s\S]*?自然文でも発火<\/button>/);
  assert.deepEqual(
    skillSwitches(on).map((row) => row.checked),
    [true, true],
    "使用スイッチは変わらない",
  );

  const off = renderSelector({ builtinSkills: [], allowNaturalInvocation: false });
  assert.ok(off.includes(MANUAL_ONLY_LABEL));
  assert.ok(off.includes(NATURAL_INVOCATION_OFF_NOTE));
  assert.equal(off.includes(NATURAL_INVOCATION_ON_NOTE), false);
  assert.deepEqual(
    skillSwitches(off).map((row) => row.checked),
    [true, true],
  );
});

test("自動起動なしはスキルの性質として行に出す", () => {
  const html = renderSelector({
    builtinSkills: [],
    fileSkills: {
      status: "ready",
      skills: [commonSkill("alpha"), commonSkill("beta", { disableModelInvocation: true })],
    },
  });
  assert.ok(html.includes("自動起動なし"));
  assert.deepEqual(
    skillSwitches(html).map((row) => row.checked),
    [true, true],
  );
});

test("一覧に無い保存名は落とさず、見つからない旨を出す", () => {
  const html = renderSelector({ builtinSkills: [], commonSkillNames: ["alpha", "gone"] });
  assert.ok(html.includes("見つかりません"));
  assert.ok(html.includes("gone"));
  assert.ok(html.includes(COMMON_SKILL_SECTION_NOTE));
  assert.ok(html.includes(BUILTIN_SECTION_NOTE));
});

test("取得失敗時は共通スキルの行を出さず、理由と再読み込みを出す", () => {
  const html = renderSelector({
    builtinSkills: [],
    commonSkillNames: [],
    fileSkills: { status: "error", message: "サンドボックスが設定されていません" },
  });
  assert.ok(html.includes(FILE_SKILL_ERROR_PREFIX));
  assert.ok(html.includes("サンドボックスが設定されていません"));
  assert.ok(html.includes(RELOAD_ABOVE_NOTE));
  assert.ok(!html.includes(`>${COMMON_SKILL_SECTION_LABEL}<`), "取得失敗時に共通のグループ見出しを出している");
  assert.deepEqual(skillSwitches(html), []);
  assert.match(html, new RegExp(`aria-label="${FILE_SKILL_RELOAD_ARIA_LABEL}"`));
  assert.ok(html.includes(FILE_SKILL_RELOAD_LABEL));
});

test("読み込み中は共通スキルの行を出さず、状態だけを出す", () => {
  const html = renderSelector({ builtinSkills: [], fileSkills: { status: "loading" } });
  assert.ok(html.includes(FILE_SKILL_LOADING_NOTE));
  assert.deepEqual(skillSwitches(html), []);
});
