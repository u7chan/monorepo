import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { fileTimeLabel } from "../src/lib/messageTime";
import type { FileSkillInfo, SandboxSkillFileDetail } from "../src/types";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { FileSkillPanel } = await import("../src/components/skill-settings/FileSkillPanel");

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

function renderPanel(skill: FileSkillInfo, detail?: SandboxSkillFileDetail): string {
  return renderToStaticMarkup(createElement(FileSkillPanel, { skill, variant: "page", detail }));
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

test("描画: 最終更新は編集内容 (detail) があるときだけ出し、保存の照合に使う版は出さない", () => {
  const mtime = 1760000000000;
  const shown = renderPanel(fileSkill(), {
    name: "alpha",
    description: "アルファの説明",
    body: "本文\n",
    relativePath: ".agents/skills/alpha/SKILL.md",
    fileVersion: "a".repeat(64),
    mtime,
    editable: true,
  });
  assert.ok(shown.includes(">最終更新<"), "最終更新が出ていない");
  assert.ok(shown.includes(fileTimeLabel(mtime)), "最終更新が時刻の表示と違う");
  assert.ok(shown.includes("SKILL.md の更新時刻（目安）"), "目安であることの補足が無い");
  assert.ok(!shown.includes(">版<"), "保存の照合に使う版が画面に出ている");

  // 組み込みは実体が無く、他のスコープは詳細を取得しないので、時刻の出どころが無い
  const builtin = renderPanel(
    fileSkill({
      scope: "builtin",
      relativePath: ".u7agent/builtin-skills/alpha/SKILL.md",
      body: "本文\n",
      version: "1",
    }),
  );
  assert.ok(!builtin.includes("最終更新"), "組み込みに最終更新が出ている");
});
