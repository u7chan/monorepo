// 同梱スキル (server/src/builtin-skills/<name>/SKILL.md) の規約と、仮想パスの解決・read 用の整形を固定する。
// バンドル本体は SDK の loadSkillsFromDir で読み込むため、ここでも同じ入口で検証する。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import {
  BUILTIN_SKILLS,
  BUILTIN_SKILLS_DIR_REL,
  builtinSkillByName,
  builtinSkillEntries,
  builtinSkillForRequestedPath,
  builtinSkillPath,
  formatBuiltinSkillBody,
} from "../src/builtin-skills";

const ROOT = "/workspace";
const BUNDLED_DIR = fileURLToPath(new URL("../src/builtin-skills/", import.meta.url));
const SKILL_CREATOR = builtinSkillByName("skill-creator");

test("同梱 SKILL.md は SDK の frontmatter 検証を通り、registry と名前が一致する", () => {
  const loaded = loadSkillsFromDir({ dir: BUNDLED_DIR, source: "u7agent" });
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(
    loaded.skills.map((skill) => skill.name),
    BUILTIN_SKILLS.map((skill) => skill.name),
  );
  for (const skill of BUILTIN_SKILLS) {
    const file = loaded.skills.find((candidate) => candidate.name === skill.name);
    assert.ok(file, `${skill.name} の SKILL.md がある`);
    assert.equal(skill.body, readFileSync(file.filePath, "utf8"));
    assert.equal(skill.disableModelInvocation, file.disableModelInvocation);
  }
});

test("同梱スキルは name / description / version の規約を満たす", () => {
  assert.ok(SKILL_CREATOR, "skill-creator が同梱されている");
  for (const skill of BUILTIN_SKILLS) {
    assert.match(skill.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${skill.name}: 小文字英数字とハイフン`);
    assert.ok(skill.name.length <= 64, `${skill.name}: 64 字以内`);
    assert.ok(skill.description.trim().length > 0, `${skill.name}: description が空でない`);
    assert.ok(skill.description.length <= 1024, `${skill.name}: description は 1024 字以内`);
    assert.ok(skill.version.trim().length > 0, `${skill.name}: version がある`);
    assert.match(skill.body, /^---\n/, `${skill.name}: frontmatter から始まる`);
    assert.match(skill.body, new RegExp(`\\nname: ${skill.name}\\n`), `${skill.name}: name が一致する`);
  }
});

test("skill-creator は置き場所・frontmatter・検証・反映タイミングを書いている", () => {
  const body = SKILL_CREATOR?.body ?? "";
  assert.match(body, /\.agents\/skills\/<name>\/SKILL\.md/);
  assert.match(body, /description:.*いつ使うか/s);
  assert.match(body, /1024/);
  assert.match(body, /64 字以内/);
  assert.match(body, /references\//);
  assert.match(body, /新規セッションと復元セッション/);
  assert.match(body, /\.pi\/skills/);
  assert.match(body, /disable-model-invocation/);
});

test("builtinSkillPath は仮想パスを組み立てる", () => {
  assert.equal(builtinSkillPath(ROOT, "skill-creator"), `${ROOT}/${BUILTIN_SKILLS_DIR_REL}/skill-creator/SKILL.md`);
});

test("builtinSkillEntries は本文と版つきの仮想エントリを返す", () => {
  const entries = builtinSkillEntries(ROOT);
  assert.equal(entries.length, BUILTIN_SKILLS.length);
  for (const entry of entries) {
    assert.equal(entry.path, builtinSkillPath(ROOT, entry.name));
    assert.equal(entry.body, builtinSkillByName(entry.name)?.body);
    assert.equal(entry.version, builtinSkillByName(entry.name)?.version);
  }
});

test("builtinSkillForRequestedPath は仮想パスだけを組み込みスキルへ解決する", () => {
  // セッション cwd は root 直下のプロジェクトか、その下の階層のどちらもあり得る
  const cwd = join(ROOT, "proj");
  const path = builtinSkillPath(ROOT, "skill-creator");
  for (const requested of [
    path,
    ".u7agent/builtin-skills/skill-creator/SKILL.md",
    `./${BUILTIN_SKILLS_DIR_REL}/skill-creator/SKILL.md`,
    `../.u7agent/builtin-skills/skill-creator/SKILL.md`,
  ]) {
    assert.equal(builtinSkillForRequestedPath(requested, { cwd, rootCwd: ROOT })?.name, "skill-creator", requested);
  }

  for (const requested of [
    // 既知の dir でも SKILL.md 以外は対象外 (同梱していない参照ファイル)
    ".u7agent/builtin-skills/skill-creator/references/schema.md",
    // 未知の名前
    ".u7agent/builtin-skills/unknown/SKILL.md",
    // root の外
    "/other/.u7agent/builtin-skills/skill-creator/SKILL.md",
    // 仮想パスですらない
    ".agents/skills/skill-creator/SKILL.md",
    "",
    undefined,
    42,
  ]) {
    assert.equal(builtinSkillForRequestedPath(requested, { cwd, rootCwd: ROOT }), undefined, String(requested));
  }
});

test("formatBuiltinSkillBody は read と同じ offset / limit の整形をする", () => {
  const skill = { ...SKILL_CREATOR!, body: "line1\nline2\nline3\nline4" };
  assert.equal(formatBuiltinSkillBody(skill), "line1\nline2\nline3\nline4");
  assert.equal(
    formatBuiltinSkillBody(skill, { offset: 2, limit: 2 }),
    "line2\nline3\n\n[1 more lines in file. Use offset=4 to continue.]",
  );
  assert.equal(formatBuiltinSkillBody(skill, { offset: 4 }), "line4");
  assert.equal(
    formatBuiltinSkillBody(skill, { limit: 1 }),
    "line1\n\n[3 more lines in file. Use offset=2 to continue.]",
  );
  assert.throws(() => formatBuiltinSkillBody(skill, { offset: 9 }), /beyond end of file/);
});
