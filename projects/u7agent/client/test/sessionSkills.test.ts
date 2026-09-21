// チャットのスキル一覧の表示用導出 (グループ分け / 注意書き / 場所の表示 / 挿入するコマンド) を DOM なしで固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_SKILL_SHADOWED_NOTE,
  groupSessionSkills,
  sessionSkillLocation,
  sessionSkillWarning,
  skillCommandText,
  skillLocationLabel,
} from "../src/lib/sessionSkills";
import type { SessionSkillInfo } from "../src/types";

const ROOT = "/workspace";

function sessionSkill(overrides: Partial<SessionSkillInfo> = {}): SessionSkillInfo {
  return {
    name: "alpha",
    description: "アルファの説明",
    scope: "user",
    location: `${ROOT}/.agents/skills/alpha/SKILL.md`,
    relativePath: ".agents/skills/alpha/SKILL.md",
    disableModelInvocation: false,
    shadowed: false,
    shadowedBy: null,
    shadows: [],
    ...overrides,
  };
}

test("groupSessionSkills は優先順位の順にまとめ、空のスコープを出さない", () => {
  const groups = groupSessionSkills([
    sessionSkill({ name: "common", scope: "user" }),
    sessionSkill({ name: "catalog", scope: "catalog", location: "catalog:catalog", relativePath: null }),
    sessionSkill({ name: "proj", scope: "project" }),
    sessionSkill({ name: "builtin", scope: "builtin" }),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.scope, group.label, group.skills.map((skill) => skill.name)]),
    [
      ["project", "プロジェクト", ["proj"]],
      ["user", "共通", ["common"]],
      ["builtin", "組み込み", ["builtin"]],
      ["catalog", "エージェント", ["catalog"]],
    ],
  );
  assert.deepEqual(groupSessionSkills([]), []);
  assert.deepEqual(
    groupSessionSkills([sessionSkill({ scope: "builtin" })]).map((group) => group.scope),
    ["builtin"],
  );
});

test("skillCommandText は引数を続けて書けるよう末尾に空白を入れる", () => {
  assert.equal(skillCommandText("writer"), "/skill:writer ");
  assert.equal(skillCommandText("writer").trim(), "/skill:writer");
});

test("skillLocationLabel は root 配下を root 相対へ落とし、仮想の値はそのまま返す", () => {
  assert.equal(skillLocationLabel(ROOT, `${ROOT}/.agents/skills/a/SKILL.md`), ".agents/skills/a/SKILL.md");
  assert.equal(skillLocationLabel(`${ROOT}/`, `${ROOT}/x/SKILL.md`), "x/SKILL.md", "root の末尾スラッシュは無視する");
  assert.equal(skillLocationLabel(ROOT, "/elsewhere/x/SKILL.md"), "/elsewhere/x/SKILL.md", "root の外は絶対パスのまま");
  assert.equal(skillLocationLabel(ROOT, "catalog:alpha"), "catalog:alpha");
  assert.equal(skillLocationLabel("", "catalog:alpha"), "catalog:alpha", "root 未取得でも壊れない");
});

test("sessionSkillWarning は使われない行と、隠している行をそれぞれ説明する", () => {
  // 同名の上位スコープがある行 (組み込み / カタログ)
  assert.equal(
    sessionSkillWarning(
      sessionSkill({ scope: "builtin", shadowed: true, shadowedBy: `${ROOT}/.agents/skills/alpha/SKILL.md` }),
      ROOT,
    ),
    `${SESSION_SKILL_SHADOWED_NOTE}: .agents/skills/alpha/SKILL.md`,
  );
  // 優先される側 (採用された行) は隠した側を示す
  assert.equal(
    sessionSkillWarning(sessionSkill({ shadows: [`${ROOT}/.agents/skills/alpha/SKILL.md`] }), ROOT),
    "同名のスキルは読み込まれません: .agents/skills/alpha/SKILL.md",
  );
  assert.equal(sessionSkillWarning(sessionSkill(), ROOT), null);
  // shadowedBy が無い (スナップショット由来の情報が欠けた) 場合も文言は出す
  assert.equal(sessionSkillWarning(sessionSkill({ shadowed: true }), ROOT), SESSION_SKILL_SHADOWED_NOTE);
});

test("sessionSkillLocation はカタログを仮想の場所で示す", () => {
  assert.equal(sessionSkillLocation(sessionSkill(), ROOT), ".agents/skills/alpha/SKILL.md");
  assert.equal(
    sessionSkillLocation(sessionSkill({ scope: "catalog", location: "catalog:alpha", relativePath: null }), ROOT),
    "catalog:alpha",
  );
});
