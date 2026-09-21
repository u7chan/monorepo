// BFF 側のファイルスキル (発見・合成・注入・一覧 API) を stub と実 SDK の resource loader で検証する。
// 実 LLM API は呼ばない (createAgentSession は組み立てない)。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatSkillsForPrompt, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createSessionResourceLoader } from "../src/agent";
import { createBffApp } from "../src/app";
import { BUILTIN_SKILLS, builtinSkillByName, builtinSkillEntries, builtinSkillPath } from "../src/builtin-skills";
import { COMMON_SKILLS_DIR, composeFileSkills, discoverSessionFileSkills } from "../src/file-skills";
import { createSecretMasker } from "../src/redact";
import { SandboxRequestError, type SandboxToolClient, type SandboxWorkspaceClient } from "../src/sandbox/client";
import type { SandboxSkillEntry, SandboxSkillsResponse } from "../src/sandbox/protocol";

function skillEntry(path: string, overrides: Partial<SandboxSkillEntry> = {}): SandboxSkillEntry {
  return {
    name: path.split("/").slice(-2)[0] ?? "skill",
    description: `${path} の説明`,
    path,
    disableModelInvocation: false,
    ...overrides,
  };
}

/** 発見経路だけを使う stub。execute などは呼ばない。 */
function skillsClient(listSkills: (dir: string) => Promise<SandboxSkillsResponse>): SandboxToolClient {
  return { listSkills } as unknown as SandboxToolClient;
}

test("composeFileSkills は project > user の優先順位で同名を一意化し、影を記録する", () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-file-skills-"));
  const projectPath = join(root, "proj/.agents/skills/shared/SKILL.md");
  const commonPath = join(root, ".agents/skills/shared/SKILL.md");
  const otherPath = join(root, ".agents/skills/other/SKILL.md");

  const composed = composeFileSkills(
    [
      { scope: "project", entries: [skillEntry(projectPath, { name: "shared", description: "プロジェクト側" })] },
      {
        scope: "user",
        entries: [
          skillEntry(commonPath, { name: "shared", description: "共通側" }),
          skillEntry(otherPath, { name: "other" }),
        ],
      },
    ],
    root,
  );

  // SDK へ渡すのは同名を畳んだ一覧 (name は一意)
  assert.deepEqual(
    composed.skills.map((skill) => [skill.name, skill.filePath, skill.sourceInfo.scope]),
    [
      ["shared", projectPath, "project"],
      ["other", otherPath, "user"],
    ],
  );
  assert.deepEqual(
    composed.response.skills.map((skill) => [skill.name, skill.relativePath, skill.scope]),
    [
      ["shared", "proj/.agents/skills/shared/SKILL.md", "project"],
      ["other", ".agents/skills/other/SKILL.md", "user"],
    ],
  );
  // 影になった側は表示用の相対パスつきで記録し、有効な側へ紐づける
  assert.deepEqual(
    composed.response.skills[0].shadowed.map((item) => item.relativePath),
    [".agents/skills/shared/SKILL.md"],
  );
  assert.deepEqual(composed.shadowed, [
    {
      name: "shared",
      keptPath: projectPath,
      shadowedPath: commonPath,
    },
  ]);
});

test("composeFileSkills は同じスコープ内の同名も先勝ちで一意化する", () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-file-skills-dupe-"));
  const first = join(root, ".agents/skills/a/SKILL.md");
  const second = join(root, ".agents/skills/b/SKILL.md");
  const composed = composeFileSkills(
    [{ scope: "user", entries: [skillEntry(first, { name: "same" }), skillEntry(second, { name: "same" })] }],
    root,
  );
  assert.deepEqual(
    composed.skills.map((skill) => skill.filePath),
    [first],
  );
  assert.equal(composed.response.skills[0].shadowed.length, 1);
});

test("discoverSessionFileSkills はプロジェクト → 共通の順で発見する", async () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-file-skills-discovery-"));
  const calls: string[] = [];
  const client = skillsClient(async (dir) => {
    calls.push(dir);
    return {
      skills: [skillEntry(join(root, dir, `${dir.replaceAll("/", "-") || "root"}/SKILL.md`))],
    };
  });

  const composed = await discoverSessionFileSkills(client, { rootCwd: root, relativeCwd: "proj" });
  assert.deepEqual(calls, [`proj/${COMMON_SKILLS_DIR}`, COMMON_SKILLS_DIR]);
  assert.deepEqual(
    composed.response.skills.map((skill) => skill.scope),
    ["project", "user", ...BUILTIN_SKILLS.map(() => "builtin")],
  );
});

test("discoverSessionFileSkills は未所属チャットのスクラッチと root 直下でプロジェクトを探さない", async () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-file-skills-scratch-"));
  const calls: string[] = [];
  const client = skillsClient(async (dir) => {
    calls.push(dir);
    return { skills: [] };
  });

  for (const relativeCwd of ["", ".u7agent/sessions/abcdef0123"]) {
    calls.length = 0;
    const composed = await discoverSessionFileSkills(client, { rootCwd: root, relativeCwd });
    assert.deepEqual(calls, [COMMON_SKILLS_DIR]);
    // サンドボックスから見つかった分は空で、組み込みだけが残る
    assert.deepEqual(
      composed.response.skills.map((skill) => skill.scope),
      BUILTIN_SKILLS.map(() => "builtin"),
    );
  }
});

test("discoverSessionFileSkills は 404 とサンドボックス障害でスキル無しに落として続行する", async () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-file-skills-degrade-"));
  const commonPath = join(root, ".agents/skills/alpha/SKILL.md");
  const client = skillsClient(async (dir) => {
    if (dir === COMMON_SKILLS_DIR) return { skills: [skillEntry(commonPath)] };
    throw new SandboxRequestError("Path not found: proj/.agents/skills", 404);
  });
  const missing = await discoverSessionFileSkills(client, { rootCwd: root, relativeCwd: "proj" });
  assert.deepEqual(
    missing.response.skills.map((skill) => skill.name),
    ["alpha", ...BUILTIN_SKILLS.map((skill) => skill.name)],
  );

  // 接続失敗 (502) でも例外を投げず、その dir だけ落とす。組み込みはサンドボックスに依らないので残る
  const failing = skillsClient(async () => {
    throw new SandboxRequestError("サンドボックスに接続できません", 502);
  });
  const degraded = await discoverSessionFileSkills(failing, { rootCwd: root, relativeCwd: "proj" });
  assert.deepEqual(
    degraded.response.skills.map((skill) => skill.name),
    BUILTIN_SKILLS.map((skill) => skill.name),
  );
});

test("composeFileSkills は組み込みを最低優先にし、上書きされた組み込みも一覧に残す", () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-builtin-compose-"));
  const userSkill = join(root, ".agents/skills/skill-creator/SKILL.md");
  const other = join(root, ".agents/skills/other/SKILL.md");
  const composed = composeFileSkills(
    [
      {
        scope: "user",
        entries: [
          skillEntry(userSkill, { name: "skill-creator", description: "ユーザー側" }),
          skillEntry(other, { name: "other" }),
        ],
      },
      { scope: "builtin", entries: builtinSkillEntries(root) },
    ],
    root,
  );

  // 注入は同名を畳む (ユーザー側が勝ち、組み込みは入らない)
  assert.deepEqual(
    composed.skills.map((skill) => [skill.name, skill.filePath]),
    [
      ["skill-creator", userSkill],
      ["other", other],
    ],
  );
  const userRow = composed.response.skills.find((row) => row.scope === "user" && row.name === "skill-creator");
  const builtinRow = composed.response.skills.find((row) => row.scope === "builtin" && row.name === "skill-creator");
  assert.equal(userRow?.overridden, false);
  // 上書きは組み込み側に立てる (ファイル同士の重複警告と二重に出さない)
  assert.deepEqual(userRow?.shadowed, []);
  assert.equal(builtinRow?.overridden, true);
  assert.equal(builtinRow?.path, builtinSkillPath(root, "skill-creator"));
  assert.equal(builtinRow?.relativePath, ".u7agent/builtin-skills/skill-creator/SKILL.md");
  assert.equal(builtinRow?.version, builtinSkillByName("skill-creator")?.version);
  assert.match(builtinRow?.body ?? "", /^---\nname: skill-creator\n/);
  // ログ用には影の組み合わせを残す
  assert.deepEqual(
    composed.shadowed.map((item) => item.name),
    ["skill-creator"],
  );
});

test("composeFileSkills は上書きが無ければ組み込みを SDK の Skill として渡す", () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-builtin-only-"));
  const composed = composeFileSkills([{ scope: "builtin", entries: builtinSkillEntries(root) }], root);
  assert.deepEqual(
    composed.skills.map((skill) => [skill.name, skill.filePath, skill.sourceInfo.scope, skill.sourceInfo.source]),
    BUILTIN_SKILLS.map((skill) => [skill.name, builtinSkillPath(root, skill.name), "temporary", "u7agent"]),
  );
  assert.deepEqual(
    fileSkillNamesForPrompt(composed),
    BUILTIN_SKILLS.map((skill) => skill.name),
  );
});

/** SDK の system prompt 一覧に入る名前 (disable-model-invocation は入らない) */
function fileSkillNamesForPrompt(composed: ReturnType<typeof composeFileSkills>): string[] {
  const skills = composed.skills.filter((skill) => !skill.disableModelInvocation);
  return formatSkillsForPrompt(skills)
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^ {4}<name>(.+)<\/name>$/);
      return match?.[1] ? [match[1]] : [];
    });
}

test("GET /api/skills/files は組み込みスキルを本文つきで返す", async () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-builtin-api-"));
  const workspace = {
    listSkills: async () => ({ skills: [] }),
  } as unknown as SandboxWorkspaceClient;
  const bff = await createBffApp({ cwd: root, sessionStoreDir: null, pi: null, workspace });
  try {
    const response = await bff.app.request("/api/skills/files");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { skills: Array<Record<string, unknown>> };
    assert.deepEqual(
      body.skills.map((skill) => skill.scope),
      BUILTIN_SKILLS.map(() => "builtin"),
    );
    const builtin = body.skills.find((skill) => skill.name === "skill-creator");
    assert.equal(builtin?.overridden, false);
    assert.equal(builtin?.relativePath, ".u7agent/builtin-skills/skill-creator/SKILL.md");
    assert.equal(builtin?.version, builtinSkillByName("skill-creator")?.version);
    assert.match(String(builtin?.body), /\.agents\/skills/);
  } finally {
    await bff.close();
  }
});

test("GET /api/skills/files は同名の共通スキルがあると組み込みを上書き表示にする", async () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-builtin-override-api-"));
  const userSkill = join(root, ".agents/skills/skill-creator/SKILL.md");
  const workspace = {
    listSkills: async () => ({ skills: [skillEntry(userSkill, { name: "skill-creator", description: "ユーザー側" })] }),
  } as unknown as SandboxWorkspaceClient;
  const bff = await createBffApp({ cwd: root, sessionStoreDir: null, pi: null, workspace });
  try {
    const body = (await (await bff.app.request("/api/skills/files")).json()) as {
      skills: Array<{ name: string; scope: string; overridden: boolean; relativePath: string }>;
    };
    const rows = body.skills.filter((skill) => skill.name === "skill-creator");
    assert.deepEqual(
      rows.map((row) => [row.scope, row.overridden]),
      [
        ["user", false],
        ["builtin", true],
      ],
    );
    // ユーザー側は "上書き" ではなく通常の行のままで、パスも実ファイルを指す
    assert.equal(rows.find((row) => row.scope === "user")?.relativePath, ".agents/skills/skill-creator/SKILL.md");
  } finally {
    await bff.close();
  }
});

test("discoverSessionFileSkills は組み込みを読み取り専用で SDK の一覧に載せる", async () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-builtin-loader-"));
  const client = skillsClient(async () => ({ skills: [] }));
  const composed = await discoverSessionFileSkills(client, { rootCwd: root, relativeCwd: "" });
  const loader = createSessionResourceLoader({
    cwd: root,
    agentDir: join(root, "agent-dir"),
    settingsManager: SettingsManager.inMemory({}),
    secretMasker: createSecretMasker([]),
    appendSystemPrompt: [],
    fileSkills: composed.skills,
  });
  await loader.reload();

  const prompt = formatSkillsForPrompt(loader.getSkills().skills);
  assert.match(prompt, /<name>skill-creator<\/name>/);
  assert.match(prompt, /\.u7agent\/builtin-skills\/skill-creator\/SKILL\.md/);
});

test("createSessionResourceLoader は skillsOverride 経由でファイルスキルを system prompt へ載せる", async () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-file-skills-loader-"));
  const composed = composeFileSkills(
    [
      {
        scope: "user",
        entries: [
          skillEntry(join(root, ".agents/skills/alpha/SKILL.md"), {
            name: "alpha",
            description: "アルファの説明",
          }),
          skillEntry(join(root, ".agents/skills/hidden/SKILL.md"), {
            name: "hidden",
            description: "明示呼び出しのみ",
            disableModelInvocation: true,
          }),
        ],
      },
    ],
    root,
  );

  const loader = createSessionResourceLoader({
    cwd: root,
    agentDir: join(root, "agent-dir"),
    settingsManager: SettingsManager.inMemory({}),
    secretMasker: createSecretMasker([]),
    appendSystemPrompt: [],
    fileSkills: composed.skills,
  });
  await loader.reload();

  // SDK は noSkills でも skillsOverride の結果を一覧に使う
  assert.deepEqual(
    loader.getSkills().skills.map((skill) => skill.name),
    ["alpha", "hidden"],
  );
  const prompt = formatSkillsForPrompt(loader.getSkills().skills);
  assert.match(prompt, /<available_skills>/);
  assert.match(prompt, /アルファの説明/);
  assert.match(prompt, /alpha\/SKILL\.md/);
  // disable-model-invocation は一覧から外れる (本文は read で読める)
  assert.doesNotMatch(prompt, /明示呼び出しのみ/);
});

test("GET /api/skills/files は共通スキルを読み取り専用の一覧として返す", async () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-file-skills-api-"));
  const first = join(root, ".agents/skills/a/SKILL.md");
  const second = join(root, ".agents/skills/shared/SKILL.md");
  const workspace = {
    listSkills: async (dir: string) => {
      assert.equal(dir, COMMON_SKILLS_DIR);
      return {
        skills: [skillEntry(first, { name: "dup" }), skillEntry(second, { name: "dup" })],
      };
    },
  } as unknown as SandboxWorkspaceClient;

  const bff = await createBffApp({ cwd: root, sessionStoreDir: null, pi: null, workspace });
  try {
    const response = await bff.app.request("/api/skills/files");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { skills: Array<Record<string, unknown>> };
    assert.equal(body.skills.length, 1 + BUILTIN_SKILLS.length);
    assert.equal(body.skills[0].name, "dup");
    assert.equal(body.skills[0].scope, "user");
    assert.equal(body.skills[0].relativePath, ".agents/skills/a/SKILL.md");
    assert.deepEqual(body.skills[0].shadowed, [{ path: second, relativePath: ".agents/skills/shared/SKILL.md" }]);
    assert.ok(body.skills.some((skill) => skill.scope === "builtin" && skill.name === "skill-creator"));
  } finally {
    await bff.close();
  }
});

test("GET /api/skills/files は未設定・サンドボックス障害・不正応答を区別して返す", async () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-file-skills-api-errors-"));
  const unconfigured = await createBffApp({ cwd: root, sessionStoreDir: null, pi: null, workspace: null });
  try {
    assert.equal((await unconfigured.app.request("/api/skills/files")).status, 503);
  } finally {
    await unconfigured.close();
  }

  const failing = {
    listSkills: async () => {
      throw new SandboxRequestError("サンドボックス (http://sandbox) に接続できません", 502);
    },
  } as unknown as SandboxWorkspaceClient;
  const down = await createBffApp({ cwd: root, sessionStoreDir: null, pi: null, workspace: failing });
  try {
    const response = await down.app.request("/api/skills/files");
    assert.equal(response.status, 502);
    assert.match(((await response.json()) as { error: string }).error, /接続できません/);
  } finally {
    await down.close();
  }

  const malformed = {
    listSkills: async () => ({ skills: [{ name: "only-name" }] }),
  } as unknown as SandboxWorkspaceClient;
  const broken = await createBffApp({ cwd: root, sessionStoreDir: null, pi: null, workspace: malformed });
  try {
    const response = await broken.app.request("/api/skills/files");
    assert.equal(response.status, 502);
    assert.match(((await response.json()) as { error: string }).error, /スキル一覧が不正/);
  } finally {
    await broken.close();
  }

  // 置き場が無いだけの 404 はエラーにせず空の一覧にする (新規 workspace の設定画面の初期表示)
  const empty = {
    listSkills: async () => {
      throw new SandboxRequestError("Path not found: /workspace/.agents/skills", 404);
    },
  } as unknown as SandboxWorkspaceClient;
  const fresh = await createBffApp({ cwd: root, sessionStoreDir: null, pi: null, workspace: empty });
  try {
    const response = await fresh.app.request("/api/skills/files");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { skills: Array<{ scope: string }> };
    // 置き場が無くても組み込みは返す (設定画面は空表示 + 組み込みグループになる)
    assert.deepEqual(
      body.skills.map((skill) => skill.scope),
      BUILTIN_SKILLS.map(() => "builtin"),
    );
  } finally {
    await fresh.close();
  }
});
