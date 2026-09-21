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
import { BUILTIN_SKILLS, builtinSkillPath } from "../src/builtin-skills";
import { SandboxRequestError, type SandboxWorkspaceClient } from "../src/sandbox/client";
import type { SandboxSkillEntry } from "../src/sandbox/protocol";
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
      deleteFile: async () => {},
      deleteDirectory: async () => {},
      uploadFile: async ({ name }) => ({ path: `uploads/${name}`, name, renamed: false, size: 0 }),
      rawFile: async () => ({ contentType: "image/png", body: null }),
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
  assert.equal(resolved[3]?.info.location, "catalog:shared");
  assert.equal(resolved[3]?.info.relativePath, null);
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

  // カタログ: 実ファイルが無いので location は catalog:<name>、References 行は入れない
  const catalog = await expandSkillCommand("/skill:catalog-writer 続き", input);
  assert.deepEqual(parseSkillBlock(catalog), {
    name: "catalog-writer",
    location: "catalog:catalog-writer",
    content: "カタログの本文",
    userMessage: "続き",
  });

  // 旧スナップショット (<skill> タグ) も name 属性で引ける
  const legacy = await expandSkillCommand("/skill:legacy", input);
  assert.equal(parseSkillBlock(legacy)?.location, "catalog:legacy");
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
