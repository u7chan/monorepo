import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { AgentDef, SkillDef } from "../src/types";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { CatalogSkillPanel } = await import("../src/components/skill-settings/CatalogSkillPanel");
const { skillFormDirty, skillFormOf } = await import("../src/components/skill-settings/SkillEditorForm");

function skill(overrides: Partial<SkillDef> = {}): SkillDef {
  return {
    id: "skill-review",
    name: "重要度順レビュー",
    description: "指摘を重要度順に並べる",
    body: "本文",
    ...overrides,
  };
}

function agent(id: string, name: string, skillIds: string[]): AgentDef {
  return { id, name, description: "", systemPrompt: "", skillIds };
}

test("下書きの差分は保存済みの内容と比べる", () => {
  const saved = skill();
  assert.equal(skillFormDirty(skillFormOf(saved), saved), false);
  assert.equal(skillFormDirty({ ...skillFormOf(saved), body: "直した" }, saved), true);
  assert.equal(skillFormDirty({ ...skillFormOf(saved), name: "改名" }, saved), true);
  assert.equal(skillFormDirty({ ...skillFormOf(saved), description: "説明を直した" }, saved), true);
  // 新規 (未保存) の下書きは空なら差分なし
  assert.equal(skillFormDirty(skillFormOf(undefined), undefined), false);
});

test("描画: 閲覧ビューは保存済みの本文と割り当て中のエージェントを出す", () => {
  const html = renderToStaticMarkup(
    createElement(CatalogSkillPanel, {
      skill: skill(),
      agents: [
        agent("agent-a", "コードレビュー", ["skill-review"]),
        agent("agent-b", "実装", ["skill-review", "skill-other"]),
      ],
      variant: "page",
      onEdit: () => {},
    }),
  );
  assert.ok(html.includes("割り当て中"), "割り当て中の行が無い");
  assert.ok(html.includes("2 件（コードレビュー、実装）"), "割り当て中の件数と名前が違う");
  assert.ok(html.includes("編集"), "編集の導線が無い");
  // 本文はカタログの応答をそのまま出す (編集中の下書きではない)
  assert.ok(html.includes("本文"), "本文が出ていない");
  assert.ok(html.includes("重要度順レビュー"), "名前が出ていない");
});

test("描画: 割り当てが 0 件でも件数を出す", () => {
  const html = renderToStaticMarkup(
    createElement(CatalogSkillPanel, {
      skill: skill(),
      agents: [agent("agent-a", "実装", [])],
      variant: "page",
      onEdit: () => {},
    }),
  );
  assert.ok(html.includes("0 件"), "0 件のとき件数を出していない");
});
