// 取り込みダイアログ (plan の一覧 / 適用後の結果) の描画契約。選択できる行と、理由の出し方を固定する。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import {
  SKILL_IMPORT_APPLIED_HEADING,
  SKILL_IMPORT_APPLYING_LABEL,
  SKILL_IMPORT_APPLY_LABEL,
  SKILL_IMPORT_NOTHING_NOTE,
  SKILL_IMPORT_PLANNING_NOTE,
  SKILL_IMPORT_SELECT_ALL_LABEL,
  SKILL_IMPORT_SKIPPED_HEADING,
  SKILL_IMPORT_STATUS_LABEL,
  skillImportSummary,
} from "../src/lib/fileSkills";
import type { SkillImportFlow } from "../src/lib/skillArchive";
import type { SandboxSkillsImportApply, SandboxSkillsImportPlan } from "../src/types";

globalThis.location ??= { origin: "http://localhost" } as Location;
const { SkillImportDialog } = await import("../src/components/skill-settings/SkillImportDialog");

const PLAN: SandboxSkillsImportPlan = {
  skills: [
    { name: "alpha", status: "new" },
    { name: "beta", status: "identical" },
    { name: "gamma", status: "conflict" },
    { name: "broken", status: "invalid", reason: "frontmatter が読めません" },
  ],
  entries: 12,
  bytes: 2048,
};

function render(flow: Exclude<SkillImportFlow, { status: "idle" }>): string {
  return renderToStaticMarkup(
    createElement(SkillImportDialog, {
      flow,
      onToggleReplace: () => {},
      onSetReplaceAll: () => {},
      onApply: () => {},
      onClose: () => {},
    }),
  );
}

/** plan の 1 行 = 1 件。チェックボックスは conflict の行と「同名をすべて選ぶ」だけに出す */
function checkboxes(html: string): string[] {
  return [...html.matchAll(/<input type="checkbox"[^>]*>/g)].map((match) => match[0]);
}

test("plan の確認中は理由だけを出し、取り込むボタンは押せない", () => {
  const html = render({ status: "planning", fileName: "skills.zip" });
  assert.ok(html.includes("skills.zip"));
  assert.ok(html.includes(SKILL_IMPORT_PLANNING_NOTE));
  assert.deepEqual(checkboxes(html), []);
  assert.match(html, new RegExp(`${SKILL_IMPORT_APPLY_LABEL}</button>`));
  assert.match(html, /<button[^>]*disabled=""[^>]*>取り込む<\/button>/);
});

test("plan は既定で 1 つも置き換えず、選べるのは同名 (conflict) の行だけ", () => {
  const html = render({ status: "review", fileName: "skills.zip", plan: PLAN, replace: [] });
  // すべての行を状態つきで出し、invalid は理由まで出す
  assert.deepEqual(
    PLAN.skills.filter((skill) => !html.includes(skill.name)).map((skill) => skill.name),
    [],
  );
  for (const status of ["new", "identical", "conflict", "invalid"] as const) {
    assert.ok(html.includes(SKILL_IMPORT_STATUS_LABEL[status]), `${status} の状態が出ていない`);
  }
  assert.ok(html.includes("frontmatter が読めません"));
  assert.ok(html.includes(skillImportSummary(1, 0)));

  // 選択は「同名あり」の行 + 全選択だけ (既定は未選択)
  const boxes = checkboxes(html);
  assert.equal(boxes.length, 2, "選択できる行の数が違う");
  assert.ok(boxes.every((box) => !box.includes("checked")));
  assert.ok(html.includes(SKILL_IMPORT_SELECT_ALL_LABEL));

  // 選んだ行だけが checked になり、要約の件数も増える。同名が 2 件あるときは全選択はまだ選ばれない
  const multi: SandboxSkillsImportPlan = {
    skills: [
      { name: "alpha", status: "new" },
      { name: "gamma", status: "conflict" },
      { name: "delta", status: "conflict" },
    ],
    entries: 12,
    bytes: 2048,
  };
  const selected = render({ status: "review", fileName: "skills.zip", plan: multi, replace: ["gamma"] });
  const selectedBoxes = checkboxes(selected);
  assert.equal(selectedBoxes.length, 3);
  assert.equal(selectedBoxes.filter((box) => box.includes("checked")).length, 1);
  assert.ok(selected.includes(skillImportSummary(2, 1)));
});

test("取り込むスキルが 1 つも無いときは理由を出し、取り込むボタンを押せない", () => {
  const plan: SandboxSkillsImportPlan = {
    skills: [
      { name: "beta", status: "identical" },
      { name: "broken", status: "invalid", reason: "name が不正です" },
    ],
    entries: 4,
    bytes: 64,
  };
  const html = render({ status: "review", fileName: "skills.zip", plan, replace: [] });
  assert.ok(html.includes(SKILL_IMPORT_NOTHING_NOTE));
  assert.match(html, /<button[^>]*disabled=""[^>]*>取り込む<\/button>/);
});

test("適用中は閉じるボタンも取り込みも押せない", () => {
  const html = render({ status: "applying", fileName: "skills.zip", plan: PLAN, replace: ["gamma"] });
  assert.ok(html.includes(SKILL_IMPORT_APPLYING_LABEL));
  assert.match(html, /<button[^>]*disabled=""[^>]*>閉じる<\/button>/);
});

test("適用後は取り込んだスキルと省略した理由を出し、取り込みの操作を消す", () => {
  const result: SandboxSkillsImportApply = {
    applied: [
      { name: "alpha", relativePath: ".agents/skills/alpha/SKILL.md", fileVersion: "a".repeat(64), replaced: false },
      { name: "gamma", relativePath: ".agents/skills/gamma/SKILL.md", fileVersion: "b".repeat(64), replaced: true },
    ],
    skipped: [{ name: "beta", reason: "内容が同一" }],
    entries: 12,
    bytes: 2048,
  };
  const html = render({ status: "applied", fileName: "skills.zip", result });
  assert.ok(html.includes(SKILL_IMPORT_APPLIED_HEADING));
  assert.ok(html.includes(SKILL_IMPORT_SKIPPED_HEADING));
  assert.ok(html.includes("alpha"));
  assert.ok(html.includes("gamma"));
  assert.ok(html.includes("内容が同一"));
  assert.ok(!html.includes(`>${SKILL_IMPORT_APPLY_LABEL}<`), "適用後に取り込みのボタンが残っている");
  assert.equal(checkboxes(html).length, 0, "適用後に選択が残っている");
});
