// BFF 側のファイルスキル (発見・合成・注入・一覧 API) を stub と実 SDK の resource loader で検証する。
// 実 LLM API は呼ばない (createAgentSession は組み立てない)。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatSkillsForPrompt, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createSessionResourceLoader } from "../src/agent";
import { COMMON_SKILLS_DIR } from "../src/app-paths";
import { createBffApp } from "../src/app";
import { BUILTIN_SKILLS, builtinSkillByName, builtinSkillEntries, builtinSkillPath } from "../src/builtin-skills";
import { composeFileSkills, discoverSessionFileSkills, type FileSkillSource } from "../src/file-skills";
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

test("composeFileSkills は共通スコープだけを許可リストで絞り、一意化の前に当てる", () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-file-skills-allowlist-"));
  const projectPath = join(root, "proj/.agents/skills/shared/SKILL.md");
  const commonShared = join(root, ".agents/skills/shared/SKILL.md");
  const commonKeep = join(root, ".agents/skills/keep/SKILL.md");
  const sources: FileSkillSource[] = [
    { scope: "project", entries: [skillEntry(projectPath, { name: "shared", description: "プロジェクト側" })] },
    {
      scope: "user",
      entries: [
        skillEntry(commonShared, { name: "shared", description: "共通側" }),
        skillEntry(commonKeep, { name: "keep" }),
      ],
    },
    { scope: "builtin", entries: builtinSkillEntries(root) },
  ];
  const builtinNames = BUILTIN_SKILLS.map((skill) => skill.name);

  // 未指定は従来どおり全可視 (共通側も一意化に参加する)
  const all = composeFileSkills(sources, root);
  assert.deepEqual(
    all.response.skills.map((row) => [row.name, row.scope]),
    [["shared", "project"], ["keep", "user"], ...builtinNames.map((name) => [name, "builtin"])],
  );
  assert.deepEqual(
    all.response.skills[0]?.shadowed.map((item) => item.relativePath),
    [".agents/skills/shared/SKILL.md"],
  );

  // ["keep"] は共通を keep だけにし、外した共通の shared はプロジェクト側が浮上して有効になる
  const filtered = composeFileSkills(sources, root, { commonSkillNames: ["keep"] });
  assert.deepEqual(
    filtered.response.skills.map((row) => [row.name, row.scope]),
    [["shared", "project"], ["keep", "user"], ...builtinNames.map((name) => [name, "builtin"])],
  );
  // 一意化の前に落とすので、影の組み合わせ自体が消える
  assert.deepEqual(filtered.response.skills[0]?.shadowed, []);
  assert.deepEqual(filtered.shadowed, []);
  assert.deepEqual(
    filtered.skills.map((skill) => skill.name),
    ["shared", "keep", ...builtinNames],
  );

  // `[]` は共通を全部落とす。プロジェクト / 組み込みは影響を受けない
  const none = composeFileSkills(sources, root, { commonSkillNames: [] });
  assert.deepEqual(
    none.response.skills.map((row) => [row.name, row.scope]),
    [["shared", "project"], ...builtinNames.map((name) => [name, "builtin"])],
  );
  assert.deepEqual(
    none.skills.map((skill) => skill.name),
    ["shared", ...builtinNames],
  );
});

test("discoverSessionFileSkills は許可リストで発見とモデル索引を揃える", async () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-file-skills-allowlist-loader-"));
  const keepPath = join(root, ".agents/skills/keep/SKILL.md");
  const dropPath = join(root, ".agents/skills/drop/SKILL.md");
  const client = skillsClient(async () => ({
    skills: [skillEntry(keepPath, { name: "keep" }), skillEntry(dropPath, { name: "drop" })],
  }));
  const builtinNames = BUILTIN_SKILLS.map((skill) => skill.name);

  // `[]` は共通を全部落とし、system prompt の available_skills にも残さない
  const off = await discoverSessionFileSkills(client, {
    rootCwd: root,
    relativeCwd: "",
    commonSkillNames: [],
  });
  assert.deepEqual(
    off.response.skills.map((row) => row.name),
    builtinNames,
  );
  assert.deepEqual(fileSkillNamesForPrompt(off), builtinNames);

  const kept = await discoverSessionFileSkills(client, {
    rootCwd: root,
    relativeCwd: "",
    commonSkillNames: ["keep"],
  });
  assert.deepEqual(
    kept.response.skills.map((row) => row.name),
    ["keep", ...builtinNames],
  );
  assert.deepEqual(fileSkillNamesForPrompt(kept), ["keep", ...builtinNames]);

  // 未指定は従来どおり全可視 (既存挙動を変えない)
  const all = await discoverSessionFileSkills(client, { rootCwd: root, relativeCwd: "" });
  assert.deepEqual(
    all.response.skills.map((row) => row.name),
    ["keep", "drop", ...builtinNames],
  );

  // 組み込みの許可リストも同じ経路で索引から落ちる (`[]` は全部 OFF)
  const builtinOff = await discoverSessionFileSkills(client, {
    rootCwd: root,
    relativeCwd: "",
    builtinSkillNames: [],
  });
  assert.deepEqual(
    builtinOff.response.skills.map((row) => row.name),
    ["keep", "drop"],
  );
  assert.deepEqual(fileSkillNamesForPrompt(builtinOff), ["keep", "drop"]);

  const builtinKept = await discoverSessionFileSkills(client, {
    rootCwd: root,
    relativeCwd: "",
    builtinSkillNames: [builtinNames[0] as string],
  });
  assert.deepEqual(
    builtinKept.response.skills.map((row) => row.name),
    ["keep", "drop", builtinNames[0]],
  );
});

test("builtinSkillNames は一意化の前に効き、外した組み込みと同名のプロジェクト側を浮上させる", () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-file-skills-builtin-allowlist-"));
  const [first, second] = BUILTIN_SKILLS;
  assert.ok(first && second);
  const overridingPath = join(root, "proj/.agents/skills", first.name, "SKILL.md");
  const sources: FileSkillSource[] = [
    { scope: "project", entries: [skillEntry(overridingPath, { name: first.name })] },
    { scope: "builtin", entries: builtinSkillEntries(root) },
  ];

  // 未指定は従来どおり全部 ON。ファイル側が勝ち、組み込みは overridden の行として残る
  const all = composeFileSkills(sources, root);
  assert.deepEqual(
    all.response.skills.map((row) => [row.name, row.scope, row.overridden]),
    [
      [first.name, "project", false],
      [first.name, "builtin", true],
      ...BUILTIN_SKILLS.slice(1).map((skill) => [skill.name, "builtin", false]),
    ],
  );

  // `[]` は組み込みを全部落とす。一意化の前に当てるので同名のプロジェクト側が浮上し、影も消える
  const none = composeFileSkills(sources, root, { builtinSkillNames: [] });
  assert.deepEqual(
    none.response.skills.map((row) => [row.name, row.scope, row.overridden]),
    [[first.name, "project", false]],
  );
  assert.deepEqual(none.response.skills[0]?.shadowed, []);
  assert.deepEqual(none.shadowed, []);

  // 明示リストは指定した名前だけを残す
  const onlySecond = composeFileSkills(sources, root, { builtinSkillNames: [second.name] });
  assert.deepEqual(
    onlySecond.response.skills.map((row) => [row.name, row.scope]),
    [
      [first.name, "project"],
      [second.name, "builtin"],
    ],
  );
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

  // 注入は同名を畳む (ユーザー側が勝ち、組み込みは入らない)。上書きされていない組み込みはそのまま入る
  assert.deepEqual(
    composed.skills.map((skill) => [skill.name, skill.filePath]),
    [
      ["skill-creator", userSkill],
      ["other", other],
      ...BUILTIN_SKILLS.filter((skill) => skill.name !== "skill-creator").map((skill) => [
        skill.name,
        builtinSkillPath(root, skill.name),
      ]),
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

test("allowNaturalInvocation=false は全スコープのスキルを索引から外す", () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-manual-skills-"));
  const projectPath = join(root, "proj/.agents/skills/project-only/SKILL.md");
  const commonPath = join(root, ".agents/skills/user-only/SKILL.md");
  const sources: FileSkillSource[] = [
    { scope: "project", entries: [skillEntry(projectPath, { name: "project-only" })] },
    { scope: "user", entries: [skillEntry(commonPath, { name: "user-only" })] },
    { scope: "builtin", entries: builtinSkillEntries(root) },
  ];

  // 既定はファイル側の指定だけに従う
  const on = composeFileSkills(sources, root);
  assert.deepEqual(fileSkillNamesForPrompt(on), [
    "project-only",
    "user-only",
    ...BUILTIN_SKILLS.map((skill) => skill.name),
  ]);

  // false ならプロジェクト / 共通 / 組み込みのすべてが索引から外れる
  const off = composeFileSkills(sources, root, { allowNaturalInvocation: false });
  assert.deepEqual(fileSkillNamesForPrompt(off), []);
  assert.ok(off.skills.every((skill) => skill.disableModelInvocation));
  assert.ok(off.response.skills.every((row) => row.disableModelInvocation));

  // ファイル側の disable-model-invocation とは OR で、false でも true のまま
  const locked = composeFileSkills(
    [{ scope: "user", entries: [skillEntry(commonPath, { name: "user-only", disableModelInvocation: true })] }],
    root,
    { allowNaturalInvocation: false },
  );
  assert.equal(locked.skills[0].disableModelInvocation, true);
  assert.equal(locked.response.skills[0].disableModelInvocation, true);
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
