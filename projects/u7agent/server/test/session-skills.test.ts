// セッションのスキル一覧 (GET /api/sessions/:id/skills) と送信経路の /skill: 展開を、
// stub の pi / サンドボックスで検証する。実 LLM API は呼ばない。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parseSkillBlock, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Hono } from "hono";
import { createBffApp } from "../src/app";
import { catalogSkillPath } from "../src/catalog-skills";
import { BUILTIN_SKILLS, builtinSkillPath } from "../src/builtin-skills";
import { SandboxRequestError, type SandboxWorkspaceClient } from "../src/sandbox/client";
import type { SandboxSkillEntry } from "../src/sandbox/protocol";
import { SessionSkillsPreviewSchema } from "../src/schema";
import {
  expandSkillCommand,
  parseCatalogSkillBlock,
  parseSkillCommand,
  resolveSessionSkills,
  type SessionSkillsInput,
} from "../src/session-skills";
import { asPiBff, createStubPi } from "./stub-pi";

const jsonPost = (payload: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const jsonBody = async (response: Response): Promise<any> => (await response.json()) as any;

function skillEntry(path: string, name: string, overrides: Partial<SandboxSkillEntry> = {}): SandboxSkillEntry {
  return { name, description: `${name} の説明`, path, disableModelInvocation: false, ...overrides };
}

/** 一覧と本文の両方を受ける stub。dir / path ごとの応答をテストが決める。 */
function stubWorkspace(input: { skills?: Record<string, SandboxSkillEntry[]>; bodies?: Record<string, string> }): {
  workspace: SandboxWorkspaceClient;
  previewed: string[];
} {
  const previewed: string[] = [];
  return {
    previewed,
    workspace: {
      listSkills: async (dir: string) => ({ skills: input.skills?.[dir] ?? [] }),
      previewFile: async (path: string) => {
        previewed.push(path);
        const text = input.bodies?.[path];
        if (text === undefined) throw new SandboxRequestError(`Path not found: ${path}`, 404);
        return { text };
      },
      listFiles: async (path: string) => ({ path: path || ".", entries: [], truncated: false }),
      createDir: async (path: string) => ({ path }),
      renameEntry: async (path: string, name: string) => ({ path, name }),
      deleteFile: async () => {},
      deleteDirectory: async () => {},
      uploadFile: async ({ name }) => ({ path: `uploads/${name}`, name, renamed: false, size: 0 }),
      rawFile: async () => ({ contentType: "image/png", body: null }),
      // ダウンロードはこのテストでは扱わない
      downloadEntry: async () => ({
        contentType: "application/octet-stream",
        contentDisposition: "attachment",
        body: null,
      }),
      checkDownload: async () => ({ kind: "file", name: "a.txt", bytes: 0, entries: 0, skipped: [] }),
    },
  };
}

const BUILTIN = BUILTIN_SKILLS[0] as (typeof BUILTIN_SKILLS)[number];

test("parseSkillCommand は SDK と同じ規則で接頭辞と最初の空白だけを見る", () => {
  assert.deepEqual(parseSkillCommand("/skill:foo"), { name: "foo", args: "" });
  assert.deepEqual(parseSkillCommand("/skill:foo bar baz"), { name: "foo", args: "bar baz" });
  assert.deepEqual(parseSkillCommand("/skill:foo   spaced  "), { name: "foo", args: "spaced" });
  assert.deepEqual(parseSkillCommand("/skill:foo\nbar"), { name: "foo\nbar", args: "" }, "改行は名前の一部");
  // 先頭以外の /skill: と、名前が空の指定は展開しない (SDK と同じ素通し)
  assert.equal(parseSkillCommand(" /skill:foo"), undefined);
  assert.equal(parseSkillCommand("/skill:"), undefined);
  assert.equal(parseSkillCommand("/skill: foo"), undefined);
  assert.equal(parseSkillCommand("スキルを使って"), undefined);
});

test("parseCatalogSkillBlock は旧 <skill> と新 <agent_skill> を name 属性で読む", () => {
  assert.deepEqual(parseCatalogSkillBlock('<agent_skill name="new">\n本文\n</agent_skill>'), {
    name: "new",
    body: "本文",
  });
  assert.deepEqual(parseCatalogSkillBlock('<skill name="old">\n本文\n</skill>'), { name: "old", body: "本文" });
  // 本文の改行と、本文中の閉じタグ風の文字列はそのまま残す (最後の閉じタグだけを落とす)
  assert.deepEqual(parseCatalogSkillBlock('<agent_skill name="x">\n1行目\n\n3行目\n</agent_skill>'), {
    name: "x",
    body: "1行目\n\n3行目",
  });
  assert.equal(parseCatalogSkillBlock("本文だけ"), undefined);
});

test("resolveSessionSkills は project > user > builtin > catalog の順で一意化し、影を記録する", async () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-session-skills-"));
  const projectPath = join(root, "proj/.agents/skills/shared/SKILL.md");
  const commonPath = join(root, ".agents/skills/shared/SKILL.md");
  const overridingPath = join(root, ".agents/skills", BUILTIN.name, "SKILL.md");
  const { workspace } = stubWorkspace({
    skills: {
      "proj/.agents/skills": [skillEntry(projectPath, "shared", { description: "プロジェクト側" })],
      ".agents/skills": [
        skillEntry(commonPath, "shared", { description: "共通側" }),
        skillEntry(overridingPath, BUILTIN.name, { disableModelInvocation: true }),
      ],
    },
  });

  const resolved = await resolveSessionSkills({
    rootCwd: root,
    relativeCwd: "proj",
    client: workspace,
    promptSnapshot: {
      agent: "",
      skills: ['<agent_skill name="shared">\nカタログ側\n</agent_skill>', '<skill name="legacy">\n旧タグ\n</skill>'],
    },
    agentSkills: [{ id: "skill-legacy", name: "legacy", description: "旧スナップショットの説明" }],
  });

  assert.deepEqual(
    resolved.map((item) => [
      item.info.name,
      item.info.scope,
      item.info.shadowed,
      item.info.shadowedBy,
      item.info.disableModelInvocation,
    ]),
    [
      // ファイル同士の重複は採用側だけが行になる (隠した側は shadows)
      ["shared", "project", false, null, false],
      [BUILTIN.name, "user", false, null, true],
      // 組み込みは上書きされても行として残り、優先される側を指す
      [BUILTIN.name, "builtin", true, overridingPath, false],
      // カタログは最低優先なので、ファイルスキルと同名なら選ばれない
      ["shared", "catalog", true, projectPath, false],
      ["legacy", "catalog", false, null, false],
    ],
  );
  assert.deepEqual(resolved[0]?.info.shadows, [commonPath]);
  assert.equal(resolved[0]?.info.relativePath, "proj/.agents/skills/shared/SKILL.md");
  assert.equal(resolved[2]?.info.relativePath, ".u7agent/builtin-skills/skill-creator/SKILL.md");
  assert.equal(resolved[3]?.info.location, catalogSkillPath(root, "shared"));
  assert.equal(resolved[3]?.info.relativePath, ".u7agent/agent-skills/shared/SKILL.md");
  // 説明はセッションのエージェントスナップショットから引く (本文には説明が無い)
  assert.equal(resolved[4]?.info.description, "旧スナップショットの説明");
});

test("resolveSessionSkills はサンドボックス無しでも組み込みとカタログを返す", async () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-session-skills-"));
  const resolved = await resolveSessionSkills({
    rootCwd: root,
    relativeCwd: "proj",
    promptSnapshot: { agent: "", skills: ['<agent_skill name="only-catalog">\n本文\n</agent_skill>'] },
  });
  assert.deepEqual(
    resolved.map((item) => [item.info.name, item.info.scope]),
    [
      [BUILTIN.name, "builtin"],
      ["only-catalog", "catalog"],
    ],
  );
});

test("resolveSessionSkills はカタログの location を encoded のまま、relativePath を表示用の名前にする", async () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-session-skills-display-"));
  const name = "重要度順レビュー";
  const resolved = await resolveSessionSkills({
    rootCwd: root,
    relativeCwd: "proj",
    promptSnapshot: { agent: "", skills: [`<agent_skill name="${name}">\n本文\n</agent_skill>`] },
    agentSkills: [{ id: "skill-1", name, description: "指摘を重要度順に並べる" }],
  });
  const catalog = resolved.find((item) => item.info.scope === "catalog")?.info;

  // read に渡す location は encoded の仮想パス、一覧の relativePath は人が読める元の名前
  assert.equal(catalog?.location, catalogSkillPath(root, name));
  assert.notEqual(catalog?.location, catalog?.relativePath);
  assert.equal(catalog?.relativePath, `.u7agent/agent-skills/${name}/SKILL.md`);
});

/** 展開の共通入力。root 配下に project / common のスキルを持つサンドボックスを組む */
function expansionFixture(options: { builtinOverridden?: boolean; previewError?: Error } = {}) {
  const root = mkdtempSync(join(tmpdir(), "u7agent-expand-"));
  const projectPath = join(root, "proj/.agents/skills/writer/SKILL.md");
  const commonPath = join(root, ".agents/skills/writer/SKILL.md");
  const overridingPath = join(root, ".agents/skills", BUILTIN.name, "SKILL.md");
  const bodies: Record<string, string> = {
    [projectPath]: "---\nname: writer\ndescription: プロジェクト側\n---\n\nプロジェクトの本文\n",
    [commonPath]: "---\nname: writer\ndescription: 共通側\n---\n\n共通の本文\n",
    [overridingPath]: "---\nname: skill-creator\n---\n\n上書きした本文\n",
  };
  const { workspace, previewed } = stubWorkspace({
    skills: {
      "proj/.agents/skills": [skillEntry(projectPath, "writer")],
      ".agents/skills": [
        skillEntry(commonPath, "writer"),
        ...(options.builtinOverridden ? [skillEntry(overridingPath, BUILTIN.name)] : []),
      ],
    },
    bodies,
  });
  const client: SessionSkillsInput["client"] = options.previewError
    ? {
        listSkills: workspace.listSkills,
        previewFile: async () => {
          throw options.previewError;
        },
      }
    : workspace;
  const input: SessionSkillsInput = {
    rootCwd: root,
    relativeCwd: "proj",
    client,
    promptSnapshot: {
      agent: "",
      skills: [
        '<agent_skill name="catalog-writer">\nカタログの本文\n</agent_skill>',
        '<skill name="legacy">\n旧タグの本文\n</skill>',
      ],
    },
    agentSkills: [{ id: "skill-1", name: "catalog-writer", description: "カタログの説明" }],
  };
  return { input, root, projectPath, commonPath, overridingPath, previewed };
}

test("expandSkillCommand はファイルスキルを frontmatter 抜きの SDK 形式ブロックへ展開する", async () => {
  const { input, projectPath } = expansionFixture();
  const expanded = await expandSkillCommand("/skill:writer 3 行で書いて", input);

  // SDK の parseSkillBlock で読み直せること (既存の _expandSkillCommand と同じ形式)
  const parsed = parseSkillBlock(expanded);
  assert.ok(parsed, `SDK が解釈できないブロック: ${expanded}`);
  assert.equal(parsed.name, "writer");
  assert.equal(parsed.location, projectPath);
  assert.equal(parsed.content, `References are relative to ${dirname(projectPath)}.\n\nプロジェクトの本文`);
  assert.equal(parsed.userMessage, "3 行で書いて");
  assert.ok(!expanded.includes("---"), "frontmatter は本文に残さない");
});

test("expandSkillCommand は引数なし・組み込み・カタログをそれぞれの形式で展開する", async () => {
  const { input, root } = expansionFixture();

  // 引数なし: ブロックだけ (末尾に空行を足さない)
  const noArgs = await expandSkillCommand("/skill:writer", input);
  assert.equal(parseSkillBlock(noArgs)?.userMessage, undefined);
  assert.equal(noArgs, noArgs.trimEnd());

  // 組み込み: 仮想パスと registry の本文 (ファイルが無いので preview は呼ばない)
  const builtin = await expandSkillCommand("/skill:skill-creator", input);
  const builtinBlock = parseSkillBlock(builtin);
  assert.equal(builtinBlock?.location, builtinSkillPath(root, BUILTIN.name));
  assert.equal(
    builtinBlock?.content,
    `References are relative to ${dirname(builtinSkillPath(root, BUILTIN.name))}.\n\n${stripFrontmatter(BUILTIN.body).trim()}`,
  );

  // カタログ: 実体の無い仮想パスを location にし、References 行は入れない (read は BFF が横取りする)
  const catalog = await expandSkillCommand("/skill:catalog-writer 続き", input);
  assert.deepEqual(parseSkillBlock(catalog), {
    name: "catalog-writer",
    location: catalogSkillPath(root, "catalog-writer"),
    content: "カタログの本文",
    userMessage: "続き",
  });

  // 旧スナップショット (<skill> タグ) も name 属性で引ける
  const legacy = await expandSkillCommand("/skill:legacy", input);
  assert.equal(parseSkillBlock(legacy)?.location, catalogSkillPath(root, "legacy"));
  assert.equal(parseSkillBlock(legacy)?.content, "旧タグの本文");
});

test("expandSkillCommand は未知の名前と対象外の本文を素通しする", async () => {
  const { input } = expansionFixture();
  assert.equal(await expandSkillCommand("/skill:unknown", input), "/skill:unknown");
  assert.equal(await expandSkillCommand("/skill:unknown 引数", input), "/skill:unknown 引数");
  assert.equal(await expandSkillCommand("writer を呼んで", input), "writer を呼んで");
  assert.equal(await expandSkillCommand(" /skill:writer", input), " /skill:writer");
});

test("expandSkillCommand は上書きされた組み込みではなく採用側の本文を使う", async () => {
  const { input, overridingPath } = expansionFixture({ builtinOverridden: true });
  const expanded = await expandSkillCommand("/skill:skill-creator", input);
  assert.equal(parseSkillBlock(expanded)?.location, overridingPath);
  assert.equal(parseSkillBlock(expanded)?.content.includes("上書きした本文"), true);
});

test("expandSkillCommand は本文が取れないときだけ 4xx / 502 で止める", async () => {
  const cases: Array<[SandboxRequestError, number, RegExp]> = [
    [new SandboxRequestError("Path not found: /workspace/x", 404), 404, /削除された可能性/],
    [new SandboxRequestError("プレビューは256 KiB以下のファイルに対応しています", 400), 400, /256 KiB/],
    [new SandboxRequestError("サンドボックスに接続できません", 502), 502, /本文を取得できません/],
  ];
  for (const [error, status, message] of cases) {
    const { input } = expansionFixture({ previewError: error });
    await assert.rejects(
      () => expandSkillCommand("/skill:writer", input),
      (thrown: unknown) => {
        assert.equal((thrown as { statusCode?: number }).statusCode, status);
        assert.match((thrown as Error).message, message);
        return true;
      },
    );
  }
});

test("expandSkillCommand は disable-model-invocation のスキルも展開する (一覧にしか出ない設定)", async () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-expand-disabled-"));
  const path = join(root, "proj/.agents/skills/manual/SKILL.md");
  const { workspace } = stubWorkspace({
    skills: { "proj/.agents/skills": [skillEntry(path, "manual", { disableModelInvocation: true })] },
    bodies: { [path]: "手動の本文" },
  });
  const expanded = await expandSkillCommand("/skill:manual", {
    rootCwd: root,
    relativeCwd: "proj",
    client: workspace,
  });
  assert.equal(parseSkillBlock(expanded)?.content, `References are relative to ${dirname(path)}.\n\n手動の本文`);
});

/** project 配下のセッションを 1 つ作る (プロジェクト登録 → セッション作成) */
async function createProjectSession(app: Hono): Promise<string> {
  const project = await app.request("/api/projects", jsonPost({ cwd: "proj", create: true }));
  assert.equal(project.status, 201);
  const projectId = (await jsonBody(project)).project.id as string;
  const session = await app.request("/api/sessions", jsonPost({ projectId }));
  assert.equal(session.status, 201);
  return (await jsonBody(session)).sessionId as string;
}

/** カタログのスキルを 1 件作り、それを割り当てたエージェントの id を返す (作成前プレビューの catalog スコープ用) */
async function createAgentWithSkill(app: Hono, name: string): Promise<string> {
  const skill = await app.request(
    "/api/skills",
    jsonPost({ name, description: `${name} の説明`, body: `${name} の本文` }),
  );
  assert.equal(skill.status, 201);
  const skillId = (await jsonBody(skill)).skill.id as string;
  const agent = await app.request("/api/agents", jsonPost({ name: `${name} のエージェント`, skillIds: [skillId] }));
  assert.equal(agent.status, 201);
  return (await jsonBody(agent)).agent.id as string;
}

test("GET /api/sessions/:id/skills はセッションのスキルを優先順位つきで返す", async () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-skills-api-"));
  const projectPath = join(root, "proj/.agents/skills/writer/SKILL.md");
  const { workspace } = stubWorkspace({ skills: { "proj/.agents/skills": [skillEntry(projectPath, "writer")] } });
  const pi = createStubPi();
  const bff = await createBffApp({ cwd: root, sessionStoreDir: null, pi: asPiBff(pi), workspace });
  try {
    const sessionId = await createProjectSession(bff.app);
    const response = await bff.app.request(`/api/sessions/${sessionId}/skills`);
    assert.equal(response.status, 200);
    const body = await jsonBody(response);
    assert.equal(body.sessionId, sessionId);
    assert.equal(body.cwd, "proj");
    assert.equal(body.projectSkills, true);
    assert.deepEqual(
      body.skills.map((skill: { name: string; scope: string; shadowed: boolean }) => [
        skill.name,
        skill.scope,
        skill.shadowed,
      ]),
      [
        ["writer", "project", false],
        [BUILTIN.name, "builtin", false],
      ],
    );

    // 未知のセッションは 404、サンドボックス未設定は 503
    assert.equal((await bff.app.request("/api/sessions/0123456789/skills")).status, 404);
  } finally {
    await bff.close();
  }

  const withoutSandbox = await createBffApp({ cwd: root, sessionStoreDir: null, pi: asPiBff(createStubPi()) });
  try {
    assert.equal((await withoutSandbox.app.request("/api/sessions/0123456789/skills")).status, 404);
  } finally {
    await withoutSandbox.close();
  }
});

test("一覧 API は発見の失敗を 502 にし、置き場が無い 404 は空として扱う", async () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-skills-strict-"));
  const pi = createStubPi();
  // 置き場が無い (404) は「そのスコープにスキルが無い」だけなので 200 + 組み込みだけ
  const missing = stubWorkspace({});
  missing.workspace.listSkills = async (dir: string) => {
    throw new SandboxRequestError(`Path not found: ${dir}`, 404);
  };
  const empty = await createBffApp({ cwd: root, sessionStoreDir: null, pi: asPiBff(pi), workspace: missing.workspace });
  try {
    const sessionId = await createProjectSession(empty.app);
    const response = await empty.app.request(`/api/sessions/${sessionId}/skills`);
    assert.equal(response.status, 200);
    assert.deepEqual(
      (await jsonBody(response)).skills.map((skill: { name: string }) => skill.name),
      [BUILTIN.name],
    );
  } finally {
    await empty.close();
  }

  // 接続できない / サンドボックス側の失敗は「取れなかった」なのでエラーにする (組み込みだけ見せて縮退しない)
  for (const status of [502, 503]) {
    const failing = stubWorkspace({});
    failing.workspace.listSkills = async () => {
      throw new SandboxRequestError("サンドボックスに接続できません", status);
    };
    const bff = await createBffApp({ cwd: root, sessionStoreDir: null, pi: asPiBff(pi), workspace: failing.workspace });
    try {
      const sessionId = await createProjectSession(bff.app);
      const response = await bff.app.request(`/api/sessions/${sessionId}/skills`);
      // サンドボックスが返した status をそのまま通す (接続失敗は SandboxRequestError の 502)
      assert.equal(response.status, status, `sandbox status=${status}`);
      assert.match((await jsonBody(response)).error, /サンドボックスに接続できません/);

      // strict は一覧だけ。セッション作成と /skill: の展開は従来どおり縮退して続く
      const builtin = await bff.app.request(
        `/api/sessions/${sessionId}/messages`,
        jsonPost({ text: `/skill:${BUILTIN.name}` }),
      );
      assert.equal(builtin.status, 202, "組み込みはサンドボックスに依らないので展開できる");
      const passthrough = await bff.app.request(
        `/api/sessions/${sessionId}/messages`,
        jsonPost({ text: "/skill:writer" }),
      );
      assert.equal(passthrough.status, 202, "発見できない名前は素通し (SDK と同じ)");
      const payload = await jsonBody(await bff.app.request(`/api/sessions/${sessionId}`));
      assert.ok(
        (payload.messages[0].text as string).startsWith(`<skill name="${BUILTIN.name}"`),
        payload.messages[0].text,
      );
      assert.equal(payload.messages.at(-2).text, "/skill:writer");
    } finally {
      await bff.close();
    }
  }
});

test("未所属セッションの一覧は projectSkills=false でプロジェクトスキルを探索しない", async () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-skills-scratch-"));
  const { workspace } = stubWorkspace({ skills: { "proj/.agents/skills": [skillEntry("/proj/x/SKILL.md", "x")] } });
  const bff = await createBffApp({ cwd: root, sessionStoreDir: null, pi: asPiBff(createStubPi()), workspace });
  try {
    const created = await bff.app.request("/api/sessions", jsonPost({}));
    const sessionId = (await jsonBody(created)).sessionId as string;
    const body = await jsonBody(await bff.app.request(`/api/sessions/${sessionId}/skills`));
    assert.equal(body.projectSkills, false);
    assert.equal(body.cwd, "");
    assert.deepEqual(
      body.skills.map((skill: { scope: string }) => skill.scope),
      ["builtin"],
    );
  } finally {
    await bff.close();
  }
});

test("POST /api/sessions/:id/messages は /skill: を展開し、タイトルは打った本文から作る", async () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-skills-post-"));
  const projectPath = join(root, "proj/.agents/skills/writer/SKILL.md");
  const { workspace, previewed } = stubWorkspace({
    skills: { "proj/.agents/skills": [skillEntry(projectPath, "writer")] },
    bodies: { [projectPath]: "---\nname: writer\n---\n\nプロジェクトの本文\n" },
  });
  const pi = createStubPi();
  const bff = await createBffApp({ cwd: root, sessionStoreDir: null, pi: asPiBff(pi), workspace });
  try {
    const sessionId = await createProjectSession(bff.app);
    const response = await bff.app.request(
      `/api/sessions/${sessionId}/messages`,
      jsonPost({ text: "/skill:writer 短く書いて" }),
    );
    assert.equal(response.status, 202);
    assert.deepEqual(previewed, [projectPath], "本文はサンドボックスから取り直す");

    const payload = await jsonBody(await bff.app.request(`/api/sessions/${sessionId}`));
    assert.equal(payload.title, "/skill:writer 短く書いて");
    const sent = payload.messages[0].text as string;
    assert.ok(sent.startsWith(`<skill name="writer" location="${projectPath}">`), sent);
    assert.ok(sent.includes("プロジェクトの本文"));
    assert.ok(sent.endsWith("\n\n短く書いて"));

    // 通常のメッセージは展開せずそのまま送る
    await bff.app.request(`/api/sessions/${sessionId}/messages`, jsonPost({ text: "そのまま" }));
    const after = await jsonBody(await bff.app.request(`/api/sessions/${sessionId}`));
    assert.equal(after.messages.at(-2).text, "そのまま");
  } finally {
    await bff.close();
  }
});

test("POST /api/sessions/:id/messages は本文が取れないスキルを送らずにエラーを返す", async () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-skills-post-error-"));
  const projectPath = join(root, "proj/.agents/skills/writer/SKILL.md");
  const { workspace } = stubWorkspace({ skills: { "proj/.agents/skills": [skillEntry(projectPath, "writer")] } });
  const pi = createStubPi();
  const bff = await createBffApp({ cwd: root, sessionStoreDir: null, pi: asPiBff(pi), workspace });
  try {
    const sessionId = await createProjectSession(bff.app);
    const response = await bff.app.request(`/api/sessions/${sessionId}/messages`, jsonPost({ text: "/skill:writer" }));
    assert.equal(response.status, 404);
    assert.match((await jsonBody(response)).error, /スキル "writer" の本文が見つかりません/);

    const payload = await jsonBody(await bff.app.request(`/api/sessions/${sessionId}`));
    assert.deepEqual(payload.messages, [], "展開に失敗したメッセージは送らない");
    assert.equal(payload.title, "", "送れなかった本文でタイトルを作らない");
  } finally {
    await bff.close();
  }
});

test("GET /api/skills/session はセッション無しで一覧を返し、同じ選択で作ったセッションの一覧と一致する", async () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-skills-preview-"));
  const projectPath = join(root, "proj/.agents/skills/writer/SKILL.md");
  const commonPath = join(root, ".agents/skills/writer/SKILL.md");
  const { workspace } = stubWorkspace({
    skills: {
      "proj/.agents/skills": [skillEntry(projectPath, "writer", { description: "プロジェクト側" })],
      ".agents/skills": [skillEntry(commonPath, "writer", { description: "共通側" })],
    },
  });
  const bff = await createBffApp({ cwd: root, sessionStoreDir: null, pi: asPiBff(createStubPi()), workspace });
  try {
    const project = await bff.app.request("/api/projects", jsonPost({ cwd: "proj", create: true }));
    const projectId = (await jsonBody(project)).project.id as string;
    const agentId = await createAgentWithSkill(bff.app, "catalog-writer");

    // 未所属 × エージェント未選択 (クエリ省略) は共通 + 組み込みだけ。cwd は "" になる
    const bare = await jsonBody(await bff.app.request("/api/skills/session"));
    assert.equal(bare.cwd, "");
    assert.equal(bare.projectSkills, false);
    assert.deepEqual(
      bare.skills.map((skill: { name: string; scope: string }) => [skill.name, skill.scope]),
      [
        ["writer", "user"],
        [BUILTIN.name, "builtin"],
      ],
    );

    // プロジェクト選択 × エージェント選択は優先順位 (project > user > builtin > catalog) と影を返す
    const response = await bff.app.request(`/api/skills/session?projectId=${projectId}&agentId=${agentId}`);
    assert.equal(response.status, 200);
    const preview = await jsonBody(response);
    assert.equal(preview.cwd, "proj");
    assert.equal(preview.projectSkills, true);
    assert.deepEqual(
      preview.skills.map((skill: { name: string; scope: string; shadowed: boolean }) => [
        skill.name,
        skill.scope,
        skill.shadowed,
      ]),
      [
        ["writer", "project", false],
        [BUILTIN.name, "builtin", false],
        ["catalog-writer", "catalog", false],
      ],
    );
    // ファイル同士の重複は敗者が行にならず (組み込み / カタログは shadowed 行として残る)、採用側の shadows に入る
    assert.deepEqual(preview.skills[0].shadows, [commonPath]);
    assert.equal(SessionSkillsPreviewSchema.safeParse(preview).success, true, "応答は schema を満たす");

    // 本文と説明の出所が同じなので、同じ選択で作ったセッションの一覧と skills は一致する
    const created = await bff.app.request("/api/sessions", jsonPost({ projectId, agentId }));
    assert.equal(created.status, 201);
    const sessionId = (await jsonBody(created)).sessionId as string;
    const session = await jsonBody(await bff.app.request(`/api/sessions/${sessionId}/skills`));
    assert.equal(session.cwd, "proj");
    assert.deepEqual(session.skills, preview.skills);

    // エージェント未選択はビルトインへ解決する (カタログのスキルは載らない)
    const withoutAgent = await jsonBody(await bff.app.request(`/api/skills/session?projectId=${projectId}`));
    assert.deepEqual(
      withoutAgent.skills.map((skill: { name: string }) => skill.name),
      ["writer", BUILTIN.name],
    );
  } finally {
    await bff.close();
  }
});

test("GET /api/skills/session は 503 / 未知の id 400 / プロジェクトディレクトリ消失 400 を返す", async () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-skills-preview-errors-"));
  const pi = createStubPi();

  // サンドボックス未設定はセッション作成と同じ 503 (組み込みだけを見せて縮退しない)
  const unconfigured = await createBffApp({ cwd: root, sessionStoreDir: null, pi: asPiBff(pi) });
  try {
    const response = await unconfigured.app.request("/api/skills/session");
    assert.equal(response.status, 503);
    assert.match((await jsonBody(response)).error, /サンドボックスが設定されていません/);
  } finally {
    await unconfigured.close();
  }

  const { workspace } = stubWorkspace({});
  // 存在確認は永続化あり × プロジェクト選択のときだけ行う (作成と同じ条件) ので、store を有効にする
  const bff = await createBffApp({
    cwd: root,
    sessionStoreDir: join(root, ".u7agent/sessions"),
    pi: asPiBff(pi),
    workspace,
  });
  try {
    const unknownProject = await bff.app.request("/api/skills/session?projectId=nope");
    assert.equal(unknownProject.status, 400);
    assert.match((await jsonBody(unknownProject)).error, /Project not found: nope/);

    const unknownAgent = await bff.app.request("/api/skills/session?agentId=nope");
    assert.equal(unknownAgent.status, 400);
    assert.match((await jsonBody(unknownAgent)).error, /Agent not found/);

    // 登録したディレクトリが消えていれば、セッション作成と同じ 400 にする (出した一覧はそのまま送れる)
    const project = await bff.app.request("/api/projects", jsonPost({ cwd: "proj", create: true }));
    const projectId = (await jsonBody(project)).project.id as string;
    workspace.listFiles = async (path: string) => {
      throw new SandboxRequestError(`Path not found: ${path}`, 404);
    };
    const missing = await bff.app.request(`/api/skills/session?projectId=${projectId}`);
    assert.equal(missing.status, 400);
    assert.match((await jsonBody(missing)).error, /Path not found: proj/);
  } finally {
    await bff.close();
  }
});

test("GET /api/skills/session は探索の 404 を空、サンドボックス由来の非 404 を sandboxFailure にする", async () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-skills-preview-strict-"));
  const pi = createStubPi();
  const cases: Array<[Error, number, RegExp]> = [
    // 置き場が無いだけの 404 は「そのスコープにスキルが無い」なので、組み込みだけを返す
    [new SandboxRequestError("Path not found: .agents/skills", 404), 200, /^$/],
    // 接続失敗 / サンドボックス側の失敗は「取れなかった」なので、サンドボックスが返した status を通す
    [new SandboxRequestError("サンドボックスに接続できません", 502), 502, /サンドボックスに接続できません/],
    [new SandboxRequestError("サンドボックスが混雑しています", 503), 503, /サンドボックスが混雑しています/],
    // SandboxRequestError 以外は内部エラーとして 500 のままにする (502 へ丸めない)
    [new Error("想定外の内部エラー"), 500, /想定外の内部エラー/],
  ];
  for (const [error, status, message] of cases) {
    const { workspace } = stubWorkspace({});
    workspace.listSkills = async () => {
      throw error;
    };
    const bff = await createBffApp({ cwd: root, sessionStoreDir: null, pi: asPiBff(pi), workspace });
    try {
      const response = await bff.app.request("/api/skills/session");
      assert.equal(response.status, status, `thrown=${error.message}`);
      const body = await jsonBody(response);
      if (status === 200) {
        assert.deepEqual(
          body.skills.map((skill: { name: string }) => skill.name),
          [BUILTIN.name],
        );
      } else {
        assert.match(body.error, message);
      }
    } finally {
      await bff.close();
    }
  }
});

test("セッション確定後は保存された projectCwd で解決し、登録解除後もプレビューへ切り替わらない", async () => {
  const root = mkdtempSync(join(tmpdir(), "u7agent-skills-restored-"));
  const projectPath = join(root, "proj/.agents/skills/writer/SKILL.md");
  const { workspace } = stubWorkspace({ skills: { "proj/.agents/skills": [skillEntry(projectPath, "writer")] } });
  const bff = await createBffApp({
    cwd: root,
    sessionStoreDir: join(root, ".u7agent/sessions"),
    pi: asPiBff(createStubPi()),
    workspace,
  });
  try {
    const project = await bff.app.request("/api/projects", jsonPost({ cwd: "proj", create: true }));
    const projectId = (await jsonBody(project)).project.id as string;
    const created = await bff.app.request("/api/sessions", jsonPost({ projectId }));
    const sessionId = (await jsonBody(created)).sessionId as string;

    // 登録解除 (保存値とディレクトリは残す) → sweep でメモリから外し、復元経路を通す
    assert.equal((await bff.app.request(`/api/projects/${projectId}`, { method: "DELETE" })).status, 200);
    const record = bff.store.records.get(sessionId);
    assert.ok(record);
    record.lastUsedAt = 0;
    await bff.store.sweep();
    assert.equal(bff.store.records.get(sessionId), undefined, "復元させる");

    const restored = await jsonBody(await bff.app.request(`/api/sessions/${sessionId}/skills`));
    assert.equal(restored.cwd, "proj", "meta.projectCwd をそのまま使う");
    assert.deepEqual(
      restored.skills.map((skill: { name: string; scope: string }) => [skill.name, skill.scope]),
      [
        ["writer", "project"],
        [BUILTIN.name, "builtin"],
      ],
    );

    // 解除済みの id はプレビューでは解決できない (セッションがある間は既存 API だけを使う根拠)
    assert.equal((await bff.app.request(`/api/skills/session?projectId=${projectId}`)).status, 400);
  } finally {
    await bff.close();
  }
});
