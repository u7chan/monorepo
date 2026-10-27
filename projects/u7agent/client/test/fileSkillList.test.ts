// 設定 → スキルの一覧。行は名前・版・自動起動なし・説明 (1 行)・使用中エージェント数だけを持ち、
// 相対パスは詳細へ譲る。選択は root 相対 relativePath で区別し、読み上げ名は名前行に閉じる。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { FileSkillList } from "../src/components/skill-settings/FileSkillList";
import type { FileSkillsState } from "../src/hooks/useFileSkills";
import {
  BUILTIN_SKILL_OVERRIDE_NOTE,
  FILE_SKILL_ERROR_PREFIX,
  FILE_SKILL_LOADING_NOTE,
  SKILL_USAGE_EMPTY_NOTE,
} from "../src/lib/fileSkills";
import { skillUsageByPath } from "../src/lib/skillUsage";
import type { AgentDef, FileSkillInfo } from "../src/types";

const common: FileSkillInfo = {
  name: "alpha",
  description: "詳細な説明",
  path: "/workspace/.agents/skills/alpha/SKILL.md",
  relativePath: ".agents/skills/alpha/SKILL.md",
  scope: "user",
  disableModelInvocation: false,
  shadowed: [],
  overridden: false,
};
const builtin: FileSkillInfo = {
  ...common,
  name: "beta",
  description: "組み込みの説明",
  path: "/workspace/.u7agent/builtin-skills/beta/SKILL.md",
  relativePath: ".u7agent/builtin-skills/beta/SKILL.md",
  scope: "builtin",
  overridden: true,
  version: "1",
};

function agent(id: string): AgentDef {
  return { id, name: id, description: "", systemPrompt: "" };
}

function render({
  state = { status: "ready", skills: [common, builtin] } as FileSkillsState,
  scope = "all" as const,
  query = "",
  usage,
  selectedRelativePath,
}: {
  state?: FileSkillsState;
  scope?: "all" | "builtin" | "common";
  query?: string;
  usage?: ReturnType<typeof skillUsageByPath>;
  selectedRelativePath?: string;
} = {}): string {
  return renderToStaticMarkup(
    createElement(FileSkillList, { state, scope, query, usage, selectedRelativePath, onSelect: () => {} }),
  );
}

test("同名スキルもパスで選択を区別し、読み上げ名に説明やパスを含めない", () => {
  const sameName: FileSkillInfo = {
    ...common,
    scope: "builtin",
    path: "/builtin/alpha/SKILL.md",
    relativePath: ".u7agent/builtin-skills/alpha/SKILL.md",
    overridden: true,
  };
  const html = render({
    state: { status: "ready", skills: [common, sameName] },
    selectedRelativePath: sameName.relativePath,
  });
  const buttons = [...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([\s\S]*?)<\/button>/g)];
  assert.equal(buttons.length, 2);
  // すべて表示では組み込みが先に並ぶ (選択は組み込み側)
  assert.deepEqual(
    buttons.map((button) => button[1]),
    ["true", "false"],
  );
  for (const button of buttons) {
    const name = button[2].replace(/<[^>]*>/g, "");
    assert.ok(name.includes("alpha"));
    assert.ok(!name.includes(common.description));
    assert.ok(!name.includes("SKILL.md"));
  }
  assert.ok(html.includes(common.description));
  // 行の識別 (data-skill-row) には使うが、見えている文字には出さない (詳細へ譲る)
  assert.ok(!html.replace(/<[^>]*>/g, "").includes(".agents/skills/alpha/SKILL.md"));
});

test("すべて表示では組み込みを先頭にし、スコープタブで絞る", () => {
  const all = render();
  assert.ok(all.indexOf(">組み込みスキル 1<") < all.indexOf(">共通 1<"));
  assert.ok(all.indexOf("beta") < all.indexOf("alpha"));

  const builtinOnly = render({ scope: "builtin" });
  assert.ok(builtinOnly.includes("beta"));
  assert.ok(!builtinOnly.includes("alpha"));

  const commonOnly = render({ scope: "common" });
  assert.ok(commonOnly.includes("alpha"));
  assert.ok(!commonOnly.includes("beta"));
});

test("検索は表示だけを絞り、一致しなければ案内を出す", () => {
  const found = render({ query: "詳細" });
  assert.ok(found.includes("alpha"));
  assert.ok(!found.includes("beta"));
  const empty = render({ query: "zzz" });
  assert.ok(empty.includes("条件に合う行がありません"));
  assert.equal(empty.includes("aria-pressed"), false);
});

test("使用中エージェント数は渡したときだけ行の右に出す", () => {
  const usage = skillUsageByPath({ agents: [agent("a1"), agent("a2")], skills: [common, builtin] });
  const html = render({ usage });
  assert.ok(html.includes("使用中 2 体"));
  assert.ok(!html.includes(SKILL_USAGE_EMPTY_NOTE));
  // カタログ未取得 (usage を渡さない) では 0 と断定しない
  const unknown = render();
  assert.ok(!unknown.includes("使用中"));
});

test("上書きされた組み込みは警告を出し、行の状態は変えない", () => {
  assert.ok(render().includes(BUILTIN_SKILL_OVERRIDE_NOTE));
});

test("取得中と失敗時は状態を表示し、以前のスキル行は出さない", () => {
  const loading = render({ state: { status: "loading" } });
  assert.ok(loading.includes(FILE_SKILL_LOADING_NOTE));
  assert.ok(!loading.includes("aria-pressed"));
  const failed = render({ state: { status: "error", message: "読み取りに失敗" } });
  assert.ok(failed.includes(FILE_SKILL_ERROR_PREFIX));
  assert.ok(failed.includes("読み取りに失敗"));
  assert.ok(!failed.includes("aria-pressed"));
});
