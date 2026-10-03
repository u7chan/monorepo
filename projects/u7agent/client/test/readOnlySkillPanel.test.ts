import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { FileSkillInfo } from "../src/types";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { ReadOnlySkillPanel } = await import("../src/components/skill-settings/ReadOnlySkillPanel");

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

function renderPanel(skill: FileSkillInfo): string {
  return renderToStaticMarkup(createElement(ReadOnlySkillPanel, { skill, variant: "page" }));
}

test("描画: ファイルタブは共通スキルに出し、組み込みには出さない", () => {
  const common = renderPanel(fileSkill());
  assert.ok(common.includes(">本文<"), "本文タブが無い");
  assert.ok(common.includes(">ファイル<"), "ファイルタブが無い");
  assert.ok(common.includes(".agents/skills/alpha/SKILL.md"), "置き場が出ていない");

  // 組み込みは実体が無い仮想パスなので、タブごと出さず本文だけを出す
  const builtin = renderPanel(
    fileSkill({
      scope: "builtin",
      relativePath: ".u7agent/builtin-skills/alpha/SKILL.md",
      body: "---\nname: alpha\n---\n本文\n",
      version: "1",
    }),
  );
  assert.ok(!builtin.includes(">ファイル<"), "組み込みにファイルタブが出ている");
  assert.ok(builtin.includes(">本文<"), "組み込みの本文が出ていない");
  assert.ok(builtin.includes("本文\n"), "組み込みの本文が一覧の応答と違う");
});
