import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import {
  BUILTIN_PANEL_SKILLS_NOTE,
  BUILTIN_PANEL_SKILLS_READONLY_LABEL,
  BuiltinAgentPanel,
} from "../src/components/agent-settings/BuiltinAgentPanel";
import type { FileSkillsState } from "../src/hooks/useFileSkills";
import {
  BUILTIN_SKILL_OVERRIDE_NOTE,
  FILE_SKILL_EMPTY_NOTE,
  FILE_SKILL_ERROR_PREFIX,
  FILE_SKILL_LOADING_NOTE,
} from "../src/lib/fileSkills";
import type { AgentDef, BuiltinSkillInfo, FileSkillInfo } from "../src/types";

const AGENT: AgentDef = {
  id: "agent-general",
  name: "汎用アシスタント",
  description: "役割や口調を設定していない既定のエージェント",
  systemPrompt: "",
  skillIds: [],
};

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

/** グループ見出しの要素。注記の文面にも同じ語が入るので、タグとして数える */
function hasCommonGroup(html: string): boolean {
  return html.includes(">共通スキル<");
}

function renderPanel({
  builtinSkills = [
    { name: "serve", description: "アプリを起動する", version: "2" },
    { name: "skill-creator", description: "スキルを作る", version: "3" },
  ] as BuiltinSkillInfo[],
  fileSkills = { status: "ready", skills: [commonSkill("alpha"), commonSkill("beta")] } as FileSkillsState,
}: { builtinSkills?: BuiltinSkillInfo[]; fileSkills?: FileSkillsState } = {}): string {
  return renderToStaticMarkup(
    createElement(BuiltinAgentPanel, { agent: AGENT, variant: "page", builtinSkills, fileSkills }),
  );
}

test("ビルトインは共通スキルと組み込みを、操作できない行として出す", () => {
  const html = renderPanel({
    fileSkills: {
      status: "ready",
      skills: [commonSkill("alpha"), commonSkill("beta", { disableModelInvocation: true })],
    },
  });
  // チェックも「すべて外す」も無い (読み取り専用)
  assert.equal(html.includes("<input"), false);
  assert.equal(html.includes("すべて外す"), false);
  assert.ok(html.includes(BUILTIN_PANEL_SKILLS_READONLY_LABEL));

  // 共通スキルは全部使用中で、件数と行が出る
  assert.ok(hasCommonGroup(html));
  assert.ok(html.includes("使用 2 / 全 2"));
  assert.ok(html.includes("alpha"));
  assert.ok(html.includes("alpha の説明"));
  assert.ok(html.includes("自動起動なし"));

  // 組み込みは同梱物の版つきで出る
  assert.ok(html.includes("serve"));
  assert.ok(html.includes("v2"));
  assert.ok(html.includes("skill-creator"));
  assert.ok(html.includes("v3"));

  assert.ok(html.includes(BUILTIN_PANEL_SKILLS_NOTE));
});

test("共通スキルの取得に失敗したら、理由を出して組み込みだけを残す", () => {
  const html = renderPanel({ fileSkills: { status: "error", message: "サンドボックスに接続できません" } });
  assert.ok(html.includes(`${FILE_SKILL_ERROR_PREFIX}: サンドボックスに接続できません`));
  assert.equal(hasCommonGroup(html), false);
  assert.ok(html.includes("serve"));
});

test("共通スキルの読み込み中も組み込みは先に出す", () => {
  const html = renderPanel({ fileSkills: { status: "loading" } });
  assert.ok(html.includes(FILE_SKILL_LOADING_NOTE));
  assert.equal(hasCommonGroup(html), false);
  assert.ok(html.includes("serve"));
});

test("同名の共通スキルに上書きされた組み込みは、使用中と数えず上書きを注記する", () => {
  const html = renderPanel({
    fileSkills: {
      status: "ready",
      skills: [commonSkill("serve"), commonSkill("skill-creator", { scope: "builtin", overridden: true })],
    },
  });
  assert.ok(html.includes("使用 1 / 全 2"));
  assert.ok(html.includes(BUILTIN_SKILL_OVERRIDE_NOTE));
});

test("共通スキルが 0 件でも、組み込みと空の案内を出す", () => {
  const html = renderPanel({ fileSkills: { status: "ready", skills: [] } });
  assert.ok(html.includes("使用 0 / 全 0"));
  assert.ok(html.includes(FILE_SKILL_EMPTY_NOTE));
  assert.ok(html.includes("serve"));
});
