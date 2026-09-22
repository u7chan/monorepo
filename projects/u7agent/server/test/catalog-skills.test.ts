// カタログ (Agent 割り当て) スキルの仮想パス・索引・read の解決を、実 SDK の resource loader で検証する。
// 実 LLM API は呼ばない (createAgentSession は組み立てない)。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { formatSkillsForPrompt, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createSessionResourceLoader } from "../src/agent";
import {
  CATALOG_SKILLS_DIR_REL,
  catalogSkillIndex,
  catalogSkillIndexForSession,
  catalogSkillNameForRequestedPath,
  catalogSkillNameFromPath,
  catalogSkillPath,
  catalogSkillRelativePath,
} from "../src/catalog-skills";
import { createSecretMasker } from "../src/redact";

const ROOT = "/workspace";

test("catalogSkillPath は .u7agent/agent-skills/<name>/SKILL.md を指す", () => {
  assert.equal(CATALOG_SKILLS_DIR_REL, ".u7agent/agent-skills");
  assert.equal(catalogSkillPath(ROOT, "writer"), `${ROOT}/.u7agent/agent-skills/writer/SKILL.md`);
  assert.equal(catalogSkillRelativePath("writer"), ".u7agent/agent-skills/writer/SKILL.md");
});

test("catalogSkillIndex は索引だけを作り、同名はファイル / 組み込み優先で落とす", () => {
  const index = catalogSkillIndex(
    ROOT,
    [
      { name: "writer", description: "文章を書く" },
      { name: "reviewer", description: "レビューする" },
      { name: "writer", description: "重複は先勝ち" },
    ],
    ["reviewer"],
  );

  assert.deepEqual(
    index.map((skill) => [skill.name, skill.filePath, skill.sourceInfo.scope, skill.sourceInfo.source]),
    [["writer", catalogSkillPath(ROOT, "writer"), "temporary", "u7agent"]],
  );
  // 本文は索引に載せない (必要時に read させる)
  assert.equal("body" in (index[0] ?? {}), false);
  const prompt = formatSkillsForPrompt(index);
  assert.match(prompt, /<name>writer<\/name>/);
  assert.match(prompt, /文章を書く/);
  assert.match(prompt, /\.u7agent\/agent-skills\/writer\/SKILL\.md/);
});

test("catalogSkillIndex は disable-model-invocation を立てない (索引に出せば呼べる)", () => {
  const [skill] = catalogSkillIndex(ROOT, [{ name: "writer", description: "" }]);
  assert.equal(skill?.disableModelInvocation, false);
});

test("catalogSkillIndexForSession はスナップショットの説明を使い、ファイル / 組み込み優先で落とす", () => {
  const index = catalogSkillIndexForSession(
    ROOT,
    [
      { name: "writer", body: "カタログの本文" },
      { name: "reviewer", body: "レビュー本文" },
      { name: "legacy", body: "旧タグの本文" },
    ],
    [
      { name: "writer", description: "作成時の説明" },
      { name: "reviewer", description: "ファイルと同名" },
    ],
    ["reviewer", "skill-creator"],
  );

  // ファイル / 組み込みと同名の reviewer は索引にも残らない (一覧の shadowed と同じ結果)
  assert.deepEqual(
    index.map((skill) => [skill.name, skill.description]),
    [
      ["writer", "作成時の説明"],
      ["legacy", ""],
    ],
  );
});

test("createSessionResourceLoader はカタログの索引を system prompt へ載せ、本文は載せない", async () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-catalog-loader-"));
  const body = "カタログの本文だけがここにある";
  const loader = createSessionResourceLoader({
    cwd: root,
    agentDir: join(root, "agent-dir"),
    settingsManager: SettingsManager.inMemory({}),
    secretMasker: createSecretMasker([]),
    appendSystemPrompt: [],
    catalogSkills: catalogSkillIndex(root, [{ name: "writer", description: "文章を書く" }]),
  });
  await loader.reload();

  const prompt = formatSkillsForPrompt(loader.getSkills().skills);
  assert.match(prompt, /<name>writer<\/name>/);
  assert.match(prompt, /文章を書く/);
  assert.match(prompt, /\.u7agent\/agent-skills\/writer\/SKILL\.md/);
  assert.ok(!prompt.includes(body), "本文が索引へ混ざっている");
});

test("catalogSkillNameForRequestedPath は絶対 / cwd 相対 / root 相対の仮想パスを解決する", () => {
  const input = { cwd: `${ROOT}/proj`, rootCwd: ROOT };
  const accepted = [
    catalogSkillPath(ROOT, "writer"),
    ".u7agent/agent-skills/writer/SKILL.md",
    "./.u7agent/agent-skills/writer/SKILL.md",
    "../.u7agent/agent-skills/writer/SKILL.md",
    `${ROOT}/proj/../.u7agent/agent-skills/writer/SKILL.md`,
  ];
  for (const requested of accepted) {
    assert.equal(catalogSkillNameForRequestedPath(requested, input), "writer", requested);
  }
});

test("catalogSkillNameForRequestedPath は対象外のパスを解決しない", () => {
  const input = { cwd: `${ROOT}/proj`, rootCwd: ROOT };
  const rejected = [
    undefined,
    "",
    "  ",
    ".u7agent/agent-skills/writer/scripts/run.sh",
    ".u7agent/agent-skills/writer",
    ".u7agent/agent-skills/writer/SKILL.md.bak",
    ".u7agent/agent-skills/writer/SKILL.md/extra",
    "/other/.u7agent/agent-skills/writer/SKILL.md",
    // 置き場から `..` で抜ける要求は弾く (`..foo` のような名前とは区別する)
    ".u7agent/agent-skills/../secret/SKILL.md",
    `${ROOT}/.u7agent/agent-skills/../../SKILL.md`,
    ".u7agent/builtin-skills/skill-creator/SKILL.md",
    ".agents/skills/writer/SKILL.md",
    42,
  ];
  for (const requested of rejected) {
    assert.equal(catalogSkillNameForRequestedPath(requested, input), undefined, String(requested));
  }
});

test("catalogSkillPath はパス区切りを含む名前でも 1 セグメントに畳む", () => {
  // 名前をそのまま使うと置き場の外へ出るため、セグメントは percent encoding で逃がす
  for (const name of ["a/b", "..", ".", "..foo", "...", "..foo/bar", "a\\b", "%2F", "重要度順レビュー"]) {
    const path = catalogSkillPath(ROOT, name);
    const segments = path.slice(`${ROOT}/.u7agent/agent-skills/`.length).split(sep);
    assert.deepEqual([segments.length, segments.at(-1)], [2, "SKILL.md"], `${name}: ${path}`);
    // 往復で元の名前に戻る (read の横取りが本文を引ける)
    assert.equal(catalogSkillNameForRequestedPath(path, { cwd: `${ROOT}/proj`, rootCwd: ROOT }), name);
  }
});

test("catalogSkillNameFromPath は仮想パスのセグメントを表示用の名前に戻す", () => {
  // `..foo` は脱出ではなく正当な名前なので、read の解決 (round-trip) と表示の両方で名前として扱う
  for (const name of ["..foo", "...", "a/b", "重要度順レビュー"]) {
    assert.equal(catalogSkillNameFromPath(catalogSkillPath(ROOT, name)), name);
    // 一覧の relativePath は人が読む表示なので、encoded ではなく元の名前で見せる
    assert.equal(catalogSkillRelativePath(name), `.u7agent/agent-skills/${name}/SKILL.md`);
  }

  // 仮想パスでないものは undefined (通常の親ディレクトリ名の導出に戻す)
  for (const path of [
    `${ROOT}/.agents/skills/writer/SKILL.md`,
    `${ROOT}/.u7agent/agent-skills/writer/scripts/run.sh`,
    `${ROOT}/.u7agent/agent-skills/SKILL.md`,
    `${ROOT}/.u7agent/builtin-skills/skill-creator/SKILL.md`,
    "SKILL.md",
  ]) {
    assert.equal(catalogSkillNameFromPath(path), undefined, path);
  }
});
