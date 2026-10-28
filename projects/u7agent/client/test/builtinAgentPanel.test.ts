import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import {
  BUILTIN_PANEL_INVOCATION_FIXED_NOTE,
  BUILTIN_PANEL_SKILLS_NOTE,
  BUILTIN_PANEL_SKILLS_READONLY_LABEL,
  BUILTIN_PANEL_TOOLS_READONLY_LABEL,
  BuiltinAgentPanel,
} from "../src/components/agent-settings/BuiltinAgentPanel";
import type { FileSkillsState } from "../src/hooks/useFileSkills";
import {
  BUILTIN_SKILL_OVERRIDE_NOTE,
  FILE_SKILL_EMPTY_NOTE,
  FILE_SKILL_ERROR_PREFIX,
  FILE_SKILL_LOADING_NOTE,
} from "../src/lib/fileSkills";
import { TOOL_CATALOG_UNAVAILABLE_NOTE } from "../src/lib/tools";
import { MANUAL_ONLY_LABEL, NATURAL_INVOCATION_LABEL } from "../src/components/agent-settings/InvocationModeRow";
import type { AgentDef, BuiltinSkillInfo, FileSkillInfo, ToolCatalogEntry } from "../src/types";

const AGENT: AgentDef = {
  id: "agent-general",
  name: "汎用アシスタント",
  description: "役割や口調を設定していない既定のエージェント",
  systemPrompt: "",
  allowNaturalInvocation: false,
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
  tools = [
    { name: "read", description: "ファイルの内容を読む", group: "sandbox", available: true },
    {
      name: "serve",
      description: "アプリを起動・確認・停止する",
      group: "app",
      available: false,
      reason: "app_disabled",
    },
  ] as ToolCatalogEntry[],
  fileSkills = { status: "ready", skills: [commonSkill("alpha"), commonSkill("beta")] } as FileSkillsState,
}: {
  builtinSkills?: BuiltinSkillInfo[];
  tools?: ToolCatalogEntry[];
  fileSkills?: FileSkillsState;
} = {}): string {
  return renderToStaticMarkup(createElement(BuiltinAgentPanel, { agent: AGENT, builtinSkills, tools, fileSkills }));
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

  // 自然文では発火しない。OFF のスイッチは読み取り専用で、手動のみのチップを出す
  const switchTag = html.match(/<button[^>]*role="switch"[^>]*>/)?.[0] ?? "";
  assert.ok(switchTag.includes('aria-checked="false"'));
  assert.ok(switchTag.includes('disabled=""'));
  assert.ok(html.includes(NATURAL_INVOCATION_LABEL));
  assert.ok(html.includes(MANUAL_ONLY_LABEL));
  assert.ok(html.includes(BUILTIN_PANEL_INVOCATION_FIXED_NOTE));

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

test("ツールも読み取り専用の行で出し、アプリ側で無効なら理由を出す", () => {
  const html = renderPanel();
  assert.ok(html.includes(BUILTIN_PANEL_TOOLS_READONLY_LABEL));
  // 作業ツールとアプリのツールを見出しで分け、行は操作できない
  assert.ok(html.includes("作業ツール"));
  assert.ok(html.includes("アプリのツール"));
  assert.equal(html.includes("<input"), false);
  assert.ok(html.includes("read"));
  assert.ok(html.includes("ファイルの内容を読む"));
  // available: false の行にはアプリ側の理由を出し、使える行には注記を足さない
  assert.ok(html.includes("アプリ側で無効です。チェックしても使えません"));
});

test("ツールの一覧を取得できないときは、行ではなく理由を出す", () => {
  const html = renderPanel({ tools: [] });
  assert.ok(html.includes(TOOL_CATALOG_UNAVAILABLE_NOTE));
  assert.equal(html.includes("作業ツール"), false);
});
