// スキル詳細の表示契約。本文 / ファイル / 使用中 の 3 タブ (組み込みは 2 タブ) で、説明は本文タブの
// 先頭に全文を出し、置き場 / 更新 / 使用中はメタの 1 行にまとめる (カードにしない)。
import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { fileTimeLabel } from "../src/lib/messageTime";
import { SKILL_USAGE_EMPTY_NOTE, SKILL_USAGE_TAB_NOTE } from "../src/lib/fileSkills";
import { SKILL_USAGE_NOTE, SKILL_USAGE_UNAVAILABLE_NOTE, skillUsageByPath } from "../src/lib/skillUsage";
import type { AgentDef, FileSkillInfo, SandboxSkillFileDetail } from "../src/types";

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

function agent(id: string, overrides: Partial<AgentDef> = {}): AgentDef {
  return { id, name: id, description: `${id} の説明`, systemPrompt: "", ...overrides };
}

function renderPanel(
  skill: FileSkillInfo,
  options: { detail?: SandboxSkillFileDetail; usage?: ReturnType<typeof skillUsageByPath> } = {},
): string {
  return renderToStaticMarkup(createElement(FileSkillPanel, { skill, detail: options.detail, usage: options.usage }));
}

test("描画: 本文 / ファイル / 使用中 の 3 タブを出し、組み込みにはファイルタブを出さない", () => {
  const common = renderPanel(fileSkill());
  assert.ok(common.includes(">本文<"), "本文タブが無い");
  assert.ok(common.includes(">ファイル<"), "ファイルタブが無い");
  assert.ok(common.includes(">使用中<"), "使用中タブが無い");
  assert.ok(common.includes(".agents/skills/alpha/SKILL.md"), "置き場が出ていない");

  // 組み込みは実体が無い仮想パスなので、ファイルタブごと出さない (root をワークスペースへ落とさない)
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
  assert.ok(builtin.includes(">使用中<"), "組み込みに使用中タブが無い");
  assert.ok(builtin.includes("本文\n"), "組み込みの本文が一覧の応答と違う");
});

test("描画: 説明は本文タブの先頭に全文を出し、ヘッダのメタに置かない", () => {
  const html = renderPanel(fileSkill({ description: "差分を読んでレビューする。根拠と影響と代替案を返す。" }));
  const descLabel = html.indexOf(">説明<");
  assert.ok(descLabel >= 0, "説明の見出しが無い");
  assert.ok(html.indexOf("差分を読んでレビューする。根拠と影響と代替案を返す。") > descLabel, "説明の全文が出ていない");
  // 置き場 / 更新 / 使用中 はメタの 1 行にまとめる
  assert.ok(html.includes(">置き場<"));
  assert.ok(html.includes(">使用中<"));
});

test("描画: 最終更新は編集内容 (detail) があるときだけ出し、保存の照合に使う版は出さない", () => {
  const mtime = 1760000000000;
  const shown = renderPanel(fileSkill(), {
    detail: {
      name: "alpha",
      description: "アルファの説明",
      body: "本文\n",
      relativePath: ".agents/skills/alpha/SKILL.md",
      fileVersion: "a".repeat(64),
      mtime,
      editable: true,
    },
  });
  assert.ok(shown.includes(">更新<"), "更新が出ていない");
  assert.ok(shown.includes(fileTimeLabel(mtime)), "更新が時刻の表示と違う");
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
  assert.ok(!builtin.includes("更新"), "組み込みに更新が出ている");
});

test("描画: 使用中タブは実効で使うエージェントだけを読み取り専用で並べる", () => {
  const skill = fileSkill();
  const usage = skillUsageByPath({
    agents: [agent("a1"), agent("a2", { commonSkillNames: [] })],
    skills: [skill],
  });
  const html = renderPanel(skill, { usage });
  assert.ok(html.includes(SKILL_USAGE_TAB_NOTE));
  // 集計の基準と対象外を件数の近くに出す (上書きされた組み込みが 0 体でも理由を補える)
  assert.ok(html.includes(SKILL_USAGE_NOTE));
  assert.ok(html.includes(">a1<"));
  assert.ok(html.includes("a1 の説明"));
  assert.ok(!html.includes(">a2<"), "外したエージェントまで並べている");
  // 件数はタブとメタの両方に出る
  assert.match(html, />使用中 1</);

  const none = renderPanel(skill, { usage: skillUsageByPath({ agents: [], skills: [skill] }) });
  assert.ok(none.includes(SKILL_USAGE_EMPTY_NOTE));

  // カタログ未取得では 0 と断定せず、件数を出さない
  const unknown = renderPanel(skill);
  assert.ok(unknown.includes(SKILL_USAGE_UNAVAILABLE_NOTE));
  assert.ok(!unknown.includes(SKILL_USAGE_EMPTY_NOTE));
});
