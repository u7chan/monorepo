// 会話ストアの永続化と復元。SessionStore とスタブ pi / スタブサンドボックスを組み合わせて検証する。

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { allowsNaturalInvocation, createAgentCatalog } from "../src/agents";
import { AppDb, type AssistantMetricsStore } from "../src/app-db";
import { sessionUploadsRel } from "../src/app-paths";
import { BUILTIN_SKILLS } from "../src/builtin-skills";
import { ProjectStore } from "../src/projects";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import type { SessionRecord } from "../src/session-record";
import { listSessionSkills, type SessionSkillsInput } from "../src/session-skills";
import { SessionStore } from "../src/sessions";
import {
  parseSessionFile,
  serializeSession,
  sessionHeaderOf,
  sessionJsonlPath,
  sessionMetaPath,
} from "../src/session-store";
import type { EventEntry, SessionPayload } from "../src/schema";
import { createStubPi, STUB_MODEL, STUB_PLAIN_MODEL, STUB_USAGE, waitFor, type StubSession } from "./stub-pi";

function stubWorkspace(): { workspace: SandboxWorkspaceClient; dirs: string[]; listings: string[] } {
  const dirs: string[] = [];
  const listings: string[] = [];
  return {
    dirs,
    listings,
    workspace: {
      previewFile: async () => ({ text: "" }),
      statFile: async (path: string) => ({ path }),
      listFiles: async (path: string) => {
        listings.push(path);
        return { path: path || ".", entries: [], truncated: false };
      },
      // ファイルスキルの発見はこのテストでは扱わない
      // git 情報はこのテストでは扱わない
      getGitInfo: async () => ({ branch: null }),
      listSkills: async () => ({ skills: [] }),
      createDir: async (path: string) => {
        dirs.push(path);
        return { path };
      },
      // 削除 / リネーム / アップロード / 生配信はこのテストでは扱わない
      renameEntry: async (path: string, name: string) => ({ path, name }),
      deleteFile: async () => {},
      deleteDirectory: async () => {},
      uploadFile: async ({ name }) => ({ path: `uploads/${name}`, name, renamed: false, size: 0 }),
      rawFile: async () => ({ status: 200, contentType: "image/png", body: null }),
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

function createStore(
  storeDir: string,
  options: {
    pi?: ReturnType<typeof createStubPi> | null;
    workspace: SandboxWorkspaceClient;
    catalog?: ReturnType<typeof createAgentCatalog>;
    projects?: ProjectStore;
    assistantMetrics?: AssistantMetricsStore | null;
  },
): SessionStore {
  return new SessionStore({
    pi: (options.pi ?? null) as never,
    catalog: options.catalog ?? createAgentCatalog(),
    projects: options.projects ?? null,
    storeDir,
    workspace: options.workspace,
    rootCwd: "/tmp/project",
    assistantMetrics: options.assistantMetrics ?? null,
  });
}

async function readMeta(id: string, storeDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(sessionMetaPath(id, storeDir), "utf8")) as Record<string, unknown>;
}

/** 共通スキルの一覧を検証するための最小の解決入力 (route の skillsInputOf と同じ値の集め方) */
function skillsInputOf(record: SessionRecord, workspace: SandboxWorkspaceClient): SessionSkillsInput {
  return {
    rootCwd: "/tmp/project",
    relativeCwd: record.workdir,
    client: workspace,
    commonSkillNames: record.agent.commonSkillNames,
    builtinSkillNames: record.agent.builtinSkillNames,
    allowNaturalInvocation: allowsNaturalInvocation(record.agent),
  };
}

/** 共通スキルを 2 件返すスタブ。許可リストの効き方だけを見る */
function commonSkillWorkspace(): SandboxWorkspaceClient {
  const { workspace } = stubWorkspace();
  workspace.listSkills = async () => ({
    skills: [
      {
        name: "keep",
        description: "残す",
        path: "/tmp/project/.agents/skills/keep/SKILL.md",
        disableModelInvocation: false,
      },
      {
        name: "drop",
        description: "外す",
        path: "/tmp/project/.agents/skills/drop/SKILL.md",
        disableModelInvocation: false,
      },
    ],
  });
  return workspace;
}

/**
 * スキル読み込み (read + SKILL.md) を、本文を持たない assistant ターンとして JSONL へ足す。
 * 復元後に導出行が繰り上げ先 (同ターン内の次の表示メッセージ) へ出ることを固定するための入力。
 */
async function appendSkillReadTurn(id: string, storeDir: string): Promise<void> {
  const file = sessionJsonlPath(id, storeDir);
  const parsed = parseSessionFile(await readFile(file, "utf8"), id);
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;
  const at = new Date().toISOString();
  const turn = [
    {
      type: "message",
      id: "entry-skill-user",
      parentId: parsed.entries.at(-1)?.id ?? null,
      timestamp: at,
      message: { role: "user", content: "スキルを読んで", timestamp: Date.now() },
    },
    {
      type: "message",
      id: "entry-skill-call",
      parentId: "entry-skill-user",
      timestamp: at,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-skill",
            name: "read",
            arguments: { path: ".agents/skills/gh/SKILL.md", offset: 3, limit: 4 },
          },
        ],
        stopReason: "stop",
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: "entry-skill-result",
      parentId: "entry-skill-call",
      timestamp: at,
      message: {
        role: "toolResult",
        toolCallId: "call-skill",
        toolName: "read",
        content: [{ type: "text", text: "スキル本文" }],
        isError: false,
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: "entry-skill-answer",
      parentId: "entry-skill-result",
      timestamp: at,
      message: { role: "assistant", content: [{ type: "text", text: "読みました" }], timestamp: Date.now() },
    },
  ];
  await writeFile(file, serializeSession(parsed.header, [...parsed.entries, ...turn]));
}

/**
 * 本文を持たない (ツール呼び出しだけの) assistant ターンを JSONL へ足す。
 * 履歴には残るが表示メッセージには数えないため、messageCount が 2 つの定義でずれる入力になる。
 */
async function appendToolOnlyTurn(id: string, storeDir: string): Promise<void> {
  const file = sessionJsonlPath(id, storeDir);
  const parsed = parseSessionFile(await readFile(file, "utf8"), id);
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;
  const at = new Date().toISOString();
  const turn = [
    {
      type: "message",
      id: "entry-tool-user",
      parentId: parsed.entries.at(-1)?.id ?? null,
      timestamp: at,
      message: { role: "user", content: "ファイルを読んで", timestamp: Date.now() },
    },
    {
      type: "message",
      id: "entry-tool-call",
      parentId: "entry-tool-user",
      timestamp: at,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } }],
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: "entry-tool-answer",
      parentId: "entry-tool-call",
      timestamp: at,
      message: { role: "assistant", content: [{ type: "text", text: "読んだ結果です" }], timestamp: Date.now() },
    },
  ];
  await writeFile(file, serializeSession(parsed.header, [...parsed.entries, ...turn]));
}

test("永続化したセッションを新しい store が復元し、続きから送信できる", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-restore-"));
  const { workspace, dirs } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const pi1 = createStubPi({ chunkDelayMs: 1 });
    const store1 = createStore(storeDir, { pi: pi1, workspace, catalog });
    await store1.init();
    const record = await store1.create();
    assert.match(record.id, /^[0-9a-f]{10}$/);
    assert.equal(record.workdir, `.u7agent/sessions/${record.id}`, "作業フォルダを cwd にする");
    // 参照画像の添付許可範囲は保存先と同じ関数で決め、作成時にツールへ渡す
    assert.equal(pi1.createInputs.at(-1)?.uploadsDirRel, sessionUploadsRel(record.id));
    assert.deepEqual(dirs, [record.workdir], "作業フォルダはサンドボックスに作らせる");

    store1.postMessage(record, "こんにちは");
    await waitFor(() => record.run?.status === "completed", 3000, "run completed");
    await store1.flush(record);

    const text = await readFile(sessionJsonlPath(record.id, storeDir), "utf8");
    const parsed = parseSessionFile(text, record.id);
    assert.equal(parsed.kind, "ok");
    if (parsed.kind !== "ok") throw new Error("unreachable");
    assert.equal(parsed.entries.length, 2, "user と assistant が保存される");
    const meta = await readMeta(record.id, storeDir);
    assert.equal(meta.title, "こんにちは");
    assert.equal(meta.messageCount, 2);
    assert.equal(meta.workdir, undefined, "作業フォルダは id から導出する (meta には保存しない)");
    await store1.close();

    // 2 つ目の store はストアを走査して descriptor を作り、開いたときに SDK を復元する
    const pi2 = createStubPi();
    const store2 = createStore(storeDir, { pi: pi2, workspace, catalog });
    await store2.init();
    const list = store2.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].sessionId, record.id);
    assert.equal(list[0].title, "こんにちは");
    assert.equal(list[0].status, "idle");
    assert.equal(list[0].messageCount, 2);

    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    const payload = store2.payload(restored);
    assert.equal(payload.cwd, record.workdir);
    assert.equal(payload.eventGeneration.length > 0, true);
    assert.deepEqual(
      payload.messages.map((message) => message.text),
      ["こんにちは", "スタブの返答です"],
      "履歴が復元される",
    );
    const input = pi2.createInputs.at(-1);
    assert.equal(input?.sessionId, record.id, "SDK へアプリの id を渡す");
    assert.equal(input?.cwd, record.workdir);
    assert.equal(input?.uploadsDirRel, sessionUploadsRel(record.id), "復元でも同じ添付置き場を渡す");
    assert.equal(input?.entries?.length, 2, "JSONL の entry を SDK へ渡す");
    assert.match(input?.promptSnapshot?.agent ?? "", /<agent_profile/);

    store2.postMessage(restored, "続き");
    await waitFor(() => restored.run?.status === "completed", 3000, "resumed run");
    await store2.flush(restored);
    const resumed = parseSessionFile(await readFile(sessionJsonlPath(record.id, storeDir), "utf8"), record.id);
    assert.equal(resumed.kind, "ok");
    if (resumed.kind === "ok") {
      // 復元時に実効モデルの model_change が 1 件追記され、その後に user + assistant が続く
      assert.equal(resumed.entries.length, 5, "追記が連結しない");
      assert.equal(resumed.entries.at(-1)?.type, "message");
    }
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("復元した会話は SDK 記録値から応答時間を概算し、由来を recorded にする", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-restore-metrics-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi({ chunkDelayMs: 5 }), workspace, catalog });
    await store1.init();
    const record = await store1.create();
    store1.postMessage(record, "こんにちは");
    await waitFor(() => record.run?.status === "completed", 3000, "run completed");
    await store1.flush(record);
    const measured = store1.payload(record).messages[1]?.metrics;
    assert.ok(measured, "live の応答時間は BFF が測る");
    assert.equal(measured.source, undefined, "実測は source を省略する");
    await store1.close();

    const file = sessionJsonlPath(record.id, storeDir);
    const parsed = parseSessionFile(await readFile(file, "utf8"), record.id);
    assert.equal(parsed.kind, "ok");
    if (parsed.kind !== "ok") return;
    // SDK が保存する durationMs を模す (リクエスト送信前からの計測なので、BFF の実測より長い)
    for (const entry of parsed.entries) {
      const message = (entry as { message?: { role?: string; durationMs?: number } }).message;
      if (message?.role === "assistant") message.durationMs = 2600;
    }
    const at = new Date().toISOString();
    const turn = [
      {
        type: "message",
        id: "entry-no-duration-user",
        parentId: parsed.entries.at(-1)?.id ?? null,
        timestamp: at,
        message: { role: "user", content: "記録値なし", timestamp: Date.now() },
      },
      {
        type: "message",
        id: "entry-no-duration-answer",
        parentId: "entry-no-duration-user",
        timestamp: at,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "記録値なしの応答" }],
          stopReason: "stop",
          timestamp: Date.now(),
          usage: STUB_USAGE,
        },
      },
    ];
    await writeFile(file, serializeSession(parsed.header, [...parsed.entries, ...turn]));

    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    const messages = store2.payload(restored).messages;
    const recorded = messages[1]?.metrics;
    assert.deepEqual(recorded, {
      durationMs: 2600,
      tokensPerSecond: (STUB_USAGE.output * 1000) / 2600,
      source: "recorded",
    });
    assert.equal(recorded?.ttftMs, undefined, "復元した値に TTFT を出さない");
    // 計測区間の始まりが違うため、duration は大きく、tok/s は小さく出る
    assert.ok((recorded?.durationMs ?? 0) > measured.durationMs, "復元値の duration が実測以下");
    assert.ok((recorded?.tokensPerSecond ?? 0) < (measured.tokensPerSecond ?? 0), "復元値の tok/s が実測以上");
    // durationMs を持たない応答は従来どおり時間も tok/s も出さない
    assert.equal(messages[3]?.metrics, undefined);
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("旧カタログ入りの meta を開いても会話は壊れず、再保存で旧キーが復活しない", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-restore-legacy-catalog-"));
  const { workspace } = stubWorkspace();
  try {
    const catalog = createAgentCatalog();
    const agent = catalog.createAgent({ name: "書き手" });
    const pi1 = createStubPi();
    const store1 = createStore(storeDir, { pi: pi1, workspace, catalog });
    const record = await store1.create({ agentId: agent.id });
    await store1.flush(record);
    await store1.close();

    // 撤去前の meta を再現する (agent.skillIds / agent.skills / promptSnapshot.skills)
    const metaPath = sessionMetaPath(record.id, storeDir);
    const legacy = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, any>;
    legacy.agent.skillIds = ["skill-1"];
    legacy.agent.skills = [{ id: "skill-1", name: "writer", description: "文章を書く" }];
    legacy.promptSnapshot.skills = ['<agent_skill name="writer">\n作成時の本文\n</agent_skill>'];
    await writeFile(metaPath, `${JSON.stringify(legacy, null, 2)}\n`);

    const pi2 = createStubPi();
    const store2 = createStore(storeDir, { pi: pi2, workspace, catalog });
    await store2.init();
    // 一覧から消えない (壊れたセッションとして扱わない)
    assert.deepEqual(
      store2.list().map((summary) => summary.sessionId),
      [record.id],
    );
    const restored = await store2.resolve(record.id);
    assert.ok(restored, "旧カタログ入りの meta でも開ける");
    assert.equal(Object.hasOwn(restored.agent, "skillIds"), false);
    assert.equal(Object.hasOwn(restored.agent, "skills"), false);
    assert.deepEqual(Object.keys(restored.promptSnapshot), ["agent"]);
    // 旧カタログの本文は現在の実行へ渡さない (一覧にも出ない)
    assert.equal(
      (await listSessionSkills(skillsInputOf(restored, workspace))).some((skill) => skill.name === "writer"),
      false,
    );
    await store2.flush(restored);
    await store2.close();

    // 開き直して再保存してもカタログ専用キーは復活しない
    const saved = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, any>;
    assert.equal(Object.hasOwn(saved.agent, "skillIds"), false);
    assert.equal(Object.hasOwn(saved.agent, "skills"), false);
    assert.equal(Object.hasOwn(saved.promptSnapshot, "skills"), false);
    assert.equal(saved.agent.name, "書き手");
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("新形式の meta は promptSnapshot.skills を持たず、再起動後の一覧でも壊れない", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-restore-no-skills-"));
  const { workspace } = stubWorkspace();
  try {
    const catalog = createAgentCatalog();
    const pi1 = createStubPi();
    const store1 = createStore(storeDir, { pi: pi1, workspace, catalog });
    const record = await store1.create({});
    await store1.flush(record);
    await store1.close();

    const meta = JSON.parse(await readFile(sessionMetaPath(record.id, storeDir), "utf8")) as Record<string, any>;
    assert.deepEqual(Object.keys(meta.promptSnapshot), ["agent"]);
    assert.equal(Object.hasOwn(meta.agent, "skillIds"), false);

    const pi2 = createStubPi();
    const store2 = createStore(storeDir, { pi: pi2, workspace, catalog });
    await store2.init();
    assert.deepEqual(
      store2.list().map((summary) => summary.sessionId),
      [record.id],
      "新形式のセッションが壊れたセッションにならない",
    );
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    assert.match(restored.promptSnapshot.agent, /<agent_profile/);
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("共通スキルの許可リストは作成時に固定され、定義を変えても復元後の一覧は変わらない", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-restore-common-skills-"));
  const workspace = commonSkillWorkspace();
  const catalog = createAgentCatalog();
  try {
    const agent = catalog.createAgent({ name: "絞った書き手", commonSkillNames: ["keep"] });
    const pi1 = createStubPi();
    const store1 = createStore(storeDir, { pi: pi1, workspace, catalog });
    const record = await store1.create({ agentId: agent.id });
    assert.deepEqual(pi1.createInputs.at(-1)?.commonSkillNames, ["keep"], "注入経路にも渡す");
    const created = (await listSessionSkills(skillsInputOf(record, workspace))).map((item) => [item.name, item.scope]);
    assert.deepEqual(created, [["keep", "user"], ...BUILTIN_SKILLS.map((skill) => [skill.name, "builtin"])]);
    await store1.flush(record);
    await store1.close();

    // 定義を編集・削除しても、復元は meta のスナップショットで解決する (遡及させない)
    catalog.updateAgent(agent.id, { commonSkillNames: [] });
    catalog.removeAgent(agent.id);
    const pi2 = createStubPi();
    const store2 = createStore(storeDir, { pi: pi2, workspace, catalog });
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    assert.deepEqual(pi2.createInputs.at(-1)?.commonSkillNames, ["keep"], "復元でも同じ許可リストを渡す");
    assert.deepEqual(
      (await listSessionSkills(skillsInputOf(restored, workspace))).map((item) => [item.name, item.scope]),
      created,
    );
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("自然文での発火はスナップショットで固定し、ビルトインは旧 meta でも常に許可しない", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-restore-natural-invocation-"));
  const workspace = commonSkillWorkspace();
  const catalog = createAgentCatalog();
  try {
    const agent = catalog.createAgent({ name: "手動専用", allowNaturalInvocation: false });
    const pi1 = createStubPi();
    const store1 = createStore(storeDir, { pi: pi1, workspace, catalog });
    const record = await store1.create({ agentId: agent.id });
    assert.equal(pi1.createInputs.at(-1)?.allowNaturalInvocation, false, "注入経路にも渡す");
    const listed = await listSessionSkills(skillsInputOf(record, workspace));
    assert.ok(listed.length > 0);
    assert.ok(
      listed.every((skill) => skill.disableModelInvocation),
      "全スキルが索引から外れる",
    );
    await store1.flush(record);
    await store1.close();

    // 定義を true に戻しても、復元は meta のスナップショット (false) を使う
    catalog.updateAgent(agent.id, { allowNaturalInvocation: true });
    const pi2 = createStubPi();
    const store2 = createStore(storeDir, { pi: pi2, workspace, catalog });
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    assert.equal(pi2.createInputs.at(-1)?.allowNaturalInvocation, false, "復元でも同じ値を渡す");
    await store2.close();

    // ビルトインは作成時から false で、値を持たない旧 meta から復元しても id で false に倒す
    const builtinPi = createStubPi();
    const builtinStore = createStore(storeDir, { pi: builtinPi, workspace, catalog });
    const builtinRecord = await builtinStore.create();
    assert.equal(builtinPi.createInputs.at(-1)?.allowNaturalInvocation, false);
    await builtinStore.flush(builtinRecord);
    await builtinStore.close();

    const meta = await readMeta(builtinRecord.id, storeDir);
    delete (meta.agent as Record<string, unknown>).allowNaturalInvocation;
    await writeFile(sessionMetaPath(builtinRecord.id, storeDir), `${JSON.stringify(meta, null, 2)}\n`);

    const restoredPi = createStubPi();
    const restoredStore = createStore(storeDir, { pi: restoredPi, workspace, catalog });
    await restoredStore.init();
    const restoredBuiltin = await restoredStore.resolve(builtinRecord.id);
    assert.ok(restoredBuiltin);
    assert.equal(
      restoredPi.createInputs.at(-1)?.allowNaturalInvocation,
      false,
      "旧 meta でもビルトインは自然文で発火させない",
    );
    assert.equal(Object.hasOwn(restoredBuiltin.agent, "allowNaturalInvocation"), false);
    await restoredStore.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("組み込みスキルの許可リストも作成時に固定され、復元でも同じ選択を使う", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-restore-builtin-skills-"));
  const workspace = commonSkillWorkspace();
  const catalog = createAgentCatalog();
  try {
    const agent = catalog.createAgent({ name: "組み込みを外した", builtinSkillNames: [] });
    const pi1 = createStubPi();
    const store1 = createStore(storeDir, { pi: pi1, workspace, catalog });
    const record = await store1.create({ agentId: agent.id });
    assert.deepEqual(pi1.createInputs.at(-1)?.builtinSkillNames, [], "注入経路にも渡す");
    const created = (await listSessionSkills(skillsInputOf(record, workspace))).map((item) => [item.name, item.scope]);
    assert.deepEqual(created, [
      ["keep", "user"],
      ["drop", "user"],
    ]);
    await store1.flush(record);
    await store1.close();

    // 定義を編集・削除しても、復元は meta のスナップショットで解決する (遡及させない)
    catalog.updateAgent(agent.id, { builtinSkillNames: ["serve"] });
    catalog.removeAgent(agent.id);
    const pi2 = createStubPi();
    const store2 = createStore(storeDir, { pi: pi2, workspace, catalog });
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    assert.deepEqual(pi2.createInputs.at(-1)?.builtinSkillNames, [], "復元でも同じ許可リストを渡す");
    assert.deepEqual(
      (await listSessionSkills(skillsInputOf(restored, workspace))).map((item) => [item.name, item.scope]),
      created,
    );
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("ツールの許可リストも作成時に固定され、定義を変えても復元では同じ選択を使う", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-restore-tool-names-"));
  const workspace = commonSkillWorkspace();
  const catalog = createAgentCatalog();
  try {
    // `[]` (すべて OFF) と明示リストは別の値として保存され、どちらも復元で保たれる
    const off = catalog.createAgent({ name: "全 OFF", toolNames: [] });
    const trimmed = catalog.createAgent({ name: "read だけ", toolNames: ["read"] });
    const pi1 = createStubPi();
    const store1 = createStore(storeDir, { pi: pi1, workspace, catalog });
    const offRecord = await store1.create({ agentId: off.id });
    assert.deepEqual(pi1.createInputs.at(-1)?.toolNames, [], "作成時にスナップショットを渡す");
    const trimmedRecord = await store1.create({ agentId: trimmed.id });
    assert.deepEqual(pi1.createInputs.at(-1)?.toolNames, ["read"]);
    await store1.flush(offRecord);
    await store1.flush(trimmedRecord);
    await store1.close();

    // 定義を編集・削除しても、復元は meta のスナップショットを使う (遡及させない)
    catalog.updateAgent(off.id, { toolNames: ["bash"] });
    catalog.removeAgent(trimmed.id);
    const pi2 = createStubPi();
    const store2 = createStore(storeDir, { pi: pi2, workspace, catalog });
    await store2.init();
    const restoredOff = await store2.resolve(offRecord.id);
    const restoredTrimmed = await store2.resolve(trimmedRecord.id);
    assert.ok(restoredOff && restoredTrimmed);
    assert.deepEqual(restoredOff.agent.toolNames, [], "`[]` を未指定へ潰さない");
    assert.deepEqual(restoredTrimmed.agent.toolNames, ["read"]);
    await store2.close();

    // フィールドを持たない古い meta は未指定 (全部 ON) として復元する
    const meta = await readMeta(restoredTrimmed.id, storeDir);
    delete (meta.agent as Record<string, unknown>).toolNames;
    await writeFile(sessionMetaPath(restoredTrimmed.id, storeDir), `${JSON.stringify(meta, null, 2)}\n`);
    const pi3 = createStubPi();
    const store3 = createStore(storeDir, { pi: pi3, workspace, catalog });
    await store3.init();
    const old = await store3.resolve(restoredTrimmed.id);
    assert.ok(old);
    assert.equal(pi3.createInputs.at(-1)?.toolNames, undefined);
    assert.equal(Object.hasOwn(old.agent, "toolNames"), false);
    await store3.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("スキル許可リストを持たない meta は未指定として復元する", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-restore-common-skills-old-"));
  const workspace = commonSkillWorkspace();
  const catalog = createAgentCatalog();
  try {
    // 全部 OFF で作ったセッションでも、フィールドを持たない meta は未指定 (全可視 / 全部 ON) として読む
    const agent = catalog.createAgent({ name: "全 OFF", commonSkillNames: [], builtinSkillNames: [] });
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    const record = await store1.create({ agentId: agent.id });
    await store1.flush(record);
    await store1.close();

    const meta = await readMeta(record.id, storeDir);
    delete (meta.agent as Record<string, unknown>).commonSkillNames;
    delete (meta.agent as Record<string, unknown>).builtinSkillNames;
    await writeFile(sessionMetaPath(record.id, storeDir), `${JSON.stringify(meta, null, 2)}\n`);

    const pi2 = createStubPi();
    const store2 = createStore(storeDir, { pi: pi2, workspace, catalog });
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    assert.equal(pi2.createInputs.at(-1)?.commonSkillNames, undefined);
    assert.equal(pi2.createInputs.at(-1)?.builtinSkillNames, undefined);
    assert.equal(Object.hasOwn(restored.agent, "commonSkillNames"), false);
    assert.equal(Object.hasOwn(restored.agent, "builtinSkillNames"), false);
    assert.deepEqual(
      (await listSessionSkills(skillsInputOf(restored, workspace))).map((item) => [item.name, item.scope]),
      [["keep", "user"], ["drop", "user"], ...BUILTIN_SKILLS.map((skill) => [skill.name, "builtin"])],
    );
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("ツール呼び出しだけのターンを含んでも meta / 一覧 / 復元後の messageCount が一致する", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-count-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const created = await store1.create();
    await store1.flush(created);
    await store1.close();

    // 保存済みの履歴へ、本文を持たない (ツール呼び出しだけの) assistant ターンを足す
    await appendToolOnlyTurn(created.id, storeDir);

    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store2.init();
    const record = await store2.resolve(created.id);
    assert.ok(record);
    const events: EventEntry[] = [];
    store2.subscribe(record, `${record.generation}:0`, (entry) => events.push(entry));
    store2.postMessage(record, "続き");
    await waitFor(() => record.run?.status === "completed", 3000, "run completed");
    await store2.flush(record);

    // 表示メッセージは「ファイルを読んで」「読んだ結果です」「続き」「スタブの返答です」の 4 件
    const live = store2.summary(record).messageCount;
    assert.equal(live, 4, "live summary は表示メッセージ数");
    assert.equal(record.session.messages.length, live + 1, "ツール呼び出しのターンは履歴には残る");
    assert.equal((await readMeta(created.id, storeDir)).messageCount, live, "meta も同じ定義");
    assert.equal(store2.payload(record).messages.length, live, "本文と件数が同じ集合");
    const runEnd = events.find((entry) => entry.type === "run_end");
    assert.ok(runEnd);
    assert.equal(runEnd.data.messageCount, live, "run_end も一覧 / meta と同じ定義");
    await store2.close();

    const store3 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store3.init();
    assert.equal(store3.list()[0]?.messageCount, live, "未ロードの一覧も meta の同じ値");
    const restored = await store3.resolve(created.id);
    assert.ok(restored);
    assert.equal(store3.summary(restored).messageCount, live, "復元後の summary も同じ値");
    await store3.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

/**
 * 画像生成ツール（generate_image）の呼び出しを含むターンを JSONL へ足す。
 * 設定が無い（ツールを公開しない）store でも復元できることを固定するための入力。
 */
async function appendGenerateImageTurn(id: string, storeDir: string): Promise<void> {
  const file = sessionJsonlPath(id, storeDir);
  const parsed = parseSessionFile(await readFile(file, "utf8"), id);
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;
  const at = new Date().toISOString();
  const turn = [
    {
      type: "message",
      id: "entry-image-user",
      parentId: parsed.entries.at(-1)?.id ?? null,
      timestamp: at,
      message: { role: "user", content: "画像を作って", timestamp: Date.now() },
    },
    {
      type: "message",
      id: "entry-image-call",
      parentId: "entry-image-user",
      timestamp: at,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-image", name: "generate_image", arguments: { prompt: "cafe" } }],
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: "entry-image-result",
      parentId: "entry-image-call",
      timestamp: at,
      message: {
        role: "toolResult",
        toolCallId: "call-image",
        toolName: "generate_image",
        content: [{ type: "text", text: "画像を生成して保存しました: generated/cafe.png" }],
        isError: false,
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: "entry-image-answer",
      parentId: "entry-image-result",
      timestamp: at,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "![cafe](generated/cafe.png)" }],
        timestamp: Date.now(),
      },
    },
  ];
  await writeFile(file, serializeSession(parsed.header, [...parsed.entries, ...turn]));
}

test("画像生成ツールが無効でも generate_image を含む履歴を復元できる", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-image-restore-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const created = await store1.create();
    await store1.flush(created);
    await store1.close();

    await appendGenerateImageTurn(created.id, storeDir);

    // この store に画像設定は無い（ツールは公開されない）。それでもセッション作成が失敗しないことを固定する。
    // 実 SDK が未知の toolCall を履歴からどう扱うかまでは stub では保証しない。
    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store2.init();
    const record = await store2.resolve(created.id);
    assert.ok(record);
    const payload = store2.payload(record);
    assert.deepEqual(
      payload.messages.map((message) => message.text),
      ["画像を作って", "![cafe](generated/cafe.png)"],
    );
    assert.ok(JSON.stringify(payload.messages).includes("generate_image"), "履歴のツール呼び出しを消さない");
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("store 経由で復元してもスキル読み込みが同じ位置に出る", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-skill-load-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const created = await store1.create();
    await store1.flush(created);
    await store1.close();

    await appendSkillReadTurn(created.id, storeDir);

    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store2.init();
    const record = await store2.resolve(created.id);
    assert.ok(record);
    const payload = store2.payload(record);

    assert.deepEqual(
      payload.messages.map((message) => [message.role, message.text]),
      [
        ["user", "スキルを読んで"],
        ["assistant", "読みました"],
      ],
      "本文を持たない read ターンはバブルにしない",
    );
    assert.deepEqual(payload.messages[1].skillLoads, [
      {
        id: "call-skill",
        name: "gh",
        path: `/tmp/project/${record.workdir}/.agents/skills/gh/SKILL.md`,
        offset: 3,
        limit: 4,
      },
    ]);
    assert.equal(store2.summary(record).messageCount, payload.messages.length, "復元後も表示メッセージ数は同じ");
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("古い定義で保存された meta の messageCount は、セッションを開いたときに書き戻す", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-backfill-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const created = await store1.create();
    // 実効モデルと一致する model_change を先に保存しておく。これが無いと復元時に
    // recordEffectiveModel が追記側で true を返し、messageCount の補正条件を検証できない
    await store1.updateSettings(created, { model: STUB_MODEL });
    store1.postMessage(created, "最初の質問");
    await waitFor(() => created.run?.status === "completed", 3000, "run completed");
    await store1.flush(created);
    await store1.close();

    await appendToolOnlyTurn(created.id, storeDir);
    // 表示は 4 件に対して生の履歴は 5 件。古い定義で書かれた meta を再現する
    const staleCount = 5;
    await writeFile(
      sessionMetaPath(created.id, storeDir),
      `${JSON.stringify({ ...(await readMeta(created.id, storeDir)), messageCount: staleCount }, null, 2)}\n`,
    );

    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store2.init();
    assert.equal(store2.list()[0]?.messageCount, staleCount, "走査は meta の保存値を使う");

    const file = sessionJsonlPath(created.id, storeDir);
    const before = await stat(file);
    const record = await store2.resolve(created.id);
    assert.ok(record);
    await store2.flush(record);
    assert.equal((await readMeta(created.id, storeDir)).messageCount, 4, "開いたときに書き戻す");
    assert.equal((await stat(file)).ino, before.ino, "履歴を書き直さず meta だけを補正する");
    await store2.close();

    const store3 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store3.init();
    assert.equal(store3.list()[0]?.messageCount, 4, "再起動後の一覧も書き戻した値");
    await store3.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("初回応答の完了前にユーザーメッセージが保存される", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-early-"));
  const { workspace } = stubWorkspace();
  try {
    const store = createStore(storeDir, { pi: createStubPi({ chunkDelayMs: 300 }), workspace });
    await store.init();
    const record = await store.create();
    store.postMessage(record, "先に保存される");

    let persisted = false;
    for (let attempt = 0; attempt < 200 && !persisted; attempt += 1) {
      const text = await readFile(sessionJsonlPath(record.id, storeDir), "utf8").catch(() => "");
      persisted = text.includes('"role":"user"');
      if (!persisted) await new Promise((resolveTick) => setTimeout(resolveTick, 5));
    }
    assert.equal(persisted, true, "assistant の完了を待たずに user entry が書かれる");
    assert.equal(record.run?.status, "running", "ランの完了前に保存されている");
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("未ロードのセッションを SDK なしで削除でき、作業フォルダは残る", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-delete-"));
  const { workspace, dirs } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const record = await store1.create();
    await store1.flush(record);
    await store1.close();

    // pi なしでも削除できる (モデル未認証・破損と無関係)
    const store2 = createStore(storeDir, { pi: null, workspace, catalog });
    await store2.init();
    assert.equal(store2.list().length, 1);
    assert.equal(await store2.deleteSession(record.id), true);
    assert.equal(store2.list().length, 0);
    await assert.rejects(readFile(sessionMetaPath(record.id, storeDir), "utf8"));
    assert.equal(await store2.deleteSession(record.id), false);
    // 作業フォルダは BFF からは作っただけで、削除では触らない
    assert.deepEqual(dirs, [record.workdir]);
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

// SDK 0.87 はリトライ / overflow recovery で context_edit、cache warming で usage を追記する。
// 未知 type を破損扱いにしていたため、これらの entry を含む履歴が再起動後に 409 で開けなくなっていた
test("リトライや cache warming が追記した entry を含む履歴も復元できる", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-context-edit-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const record = await store1.create();
    await store1.flush(record);
    await store1.close();

    const timestamp = new Date().toISOString();
    const text = serializeSession(sessionHeaderOf({ id: record.id, createdAt: Date.now() }, record.workdir), [
      {
        type: "message",
        id: "entry-1",
        parentId: null,
        timestamp,
        message: { role: "user", content: "hello", timestamp: 1 },
      },
      {
        type: "context_edit",
        id: "entry-2",
        parentId: "entry-1",
        timestamp,
        targetId: "entry-1",
        replacement: null,
      },
      {
        type: "usage",
        id: "entry-3",
        parentId: "entry-2",
        timestamp,
        kind: "cache_warm",
        provider: "openai",
        model: "gpt-6-luna",
        usage: { input: 1, output: 0, cacheRead: 9, cacheWrite: 0 },
      },
    ]);
    await writeFile(sessionJsonlPath(record.id, storeDir), text);

    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored, "409 にならずに復元できる");
    const entries = (restored.session as StubSession).entries;
    const ids = entries.map((entry) => entry.id);
    for (const id of ["entry-1", "entry-2", "entry-3"]) {
      assert.ok(ids.includes(id), `${id} が SDK へ渡る`);
    }
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

// SDK 0.87 は tool 構成や system prompt の section 差分を role: "system" の message として追記する。
// role を未知として扱っていたため、それを含む履歴が再起動後に 409 で開けなくなっていた
test("system prompt の差分を追記した履歴も復元できる", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-system-message-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const record = await store1.create();
    await store1.flush(record);
    await store1.close();

    const timestamp = new Date().toISOString();
    const text = serializeSession(sessionHeaderOf({ id: record.id, createdAt: Date.now() }, record.workdir), [
      {
        type: "message",
        id: "entry-1",
        parentId: null,
        timestamp,
        message: { role: "user", content: "hello", timestamp: 1 },
      },
      {
        type: "message",
        id: "entry-2",
        parentId: "entry-1",
        timestamp,
        // SDK が書く形: 本文は空で、差分は sections に入る
        message: { role: "system", content: "", sections: { skills: "<skills>…</skills>" }, timestamp: 2 },
      },
    ]);
    await writeFile(sessionJsonlPath(record.id, storeDir), text);

    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored, "409 にならずに復元できる");
    const ids = (restored.session as StubSession).entries.map((entry) => entry.id);
    for (const id of ["entry-1", "entry-2"]) {
      assert.ok(ids.includes(id), `${id} が SDK へ渡る`);
    }
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("壊れた JSONL は原本を書き換えずに開く要求が失敗し、削除はできる", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-damaged-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const record = await store1.create();
    await store1.flush(record);
    await store1.close();

    const broken = '{"broken"\n';
    await writeFile(sessionJsonlPath(record.id, storeDir), broken);
    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store2.init();
    await assert.rejects(store2.resolve(record.id), (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 409);
      return true;
    });
    // 原本はそのまま (読み込みで書き換えない)
    assert.equal(await readFile(sessionJsonlPath(record.id, storeDir), "utf8"), broken);
    assert.equal(await store2.deleteSession(record.id), true);
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("content part が壊れた履歴は 409 で拒否し、原本を書き換えない", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-damaged-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const record = await store1.create();
    await store1.flush(record);
    await store1.close();

    const broken = serializeSession(sessionHeaderOf({ id: record.id, createdAt: Date.now() }, record.workdir), [
      {
        type: "message",
        id: "entry-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: [{ type: "text" }], timestamp: Date.now() },
      },
    ]);
    await writeFile(sessionJsonlPath(record.id, storeDir), broken);

    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store2.init();
    await assert.rejects(store2.resolve(record.id), (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /session.jsonl/);
      return true;
    });
    assert.equal(await readFile(sessionJsonlPath(record.id, storeDir), "utf8"), broken, "原本は変わらない");
    assert.equal(await store2.deleteSession(record.id), true);
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("PI_MODELS の候補外モデルでは再開せず、フォールバック後の実効モデルを保存する", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-model-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const pi1 = createStubPi();
    const store1 = createStore(storeDir, { pi: pi1, workspace, catalog });
    await store1.init();
    const record = await store1.create({ model: { provider: "stub", id: "stub-model" } });
    store1.postMessage(record, "モデルを記録する");
    await waitFor(() => record.run?.status === "completed", 3000, "run completed");
    await store1.flush(record);
    assert.equal((await readMeta(record.id, storeDir)).model, "stub/stub-model");
    await store1.close();

    // 復元側の候補は stub-plain だけ。保存値は選ばれず、実効値が JSONL に追記される
    const pi2 = createStubPi({ availableModels: [STUB_PLAIN_MODEL], selectedModel: STUB_PLAIN_MODEL });
    const store2 = createStore(storeDir, { pi: pi2, workspace, catalog });
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    assert.equal(pi2.createInputs.at(-1)?.model, undefined, "候補外の保存値は渡さない (アプリ既定へ任せる)");
    await store2.flush(restored);
    const text = await readFile(sessionJsonlPath(record.id, storeDir), "utf8");
    const parsed = parseSessionFile(text, record.id);
    assert.equal(parsed.kind, "ok");
    if (parsed.kind === "ok") {
      const last = [...parsed.entries].reverse().find((entry) => entry.type === "model_change");
      assert.equal(last?.provider, "stub", "フォールバック後の実効モデルを記録する");
      assert.equal(last?.modelId, "stub-plain");
    }
    await store2.close();

    // 3 つ目の store は両方使えても、最後に記録された stub-plain で再開する
    const pi3 = createStubPi();
    const store3 = createStore(storeDir, { pi: pi3, workspace, catalog });
    await store3.init();
    const again = await store3.resolve(record.id);
    assert.ok(again);
    assert.deepEqual(pi3.createInputs.at(-1)?.model, { provider: "stub", id: "stub-plain" });
    await store3.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("復元後の SSE は世代が違うカーソルを resync へ寄せる", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-sse-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const record = await store1.create();
    await store1.flush(record);
    await store1.close();

    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);

    // 古い世代のカーソル (再起動前のタブ) は resync
    const stale: EventEntry[] = [];
    store2.subscribe(restored, "deadbeef:3", (entry) => stale.push(entry));
    const first = stale[0];
    assert.ok(first);
    assert.equal(first.type, "resync");
    assert.equal((first.data as SessionPayload).sessionId, record.id);

    // 現在の世代で最新まで読んでいるタブには何も送らない
    const current: EventEntry[] = [];
    store2.subscribe(restored, `${restored.generation}:${restored.seq}`, (entry) => current.push(entry));
    assert.deepEqual(current, []);
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("compaction を保存し、復元後も区切りが再現される", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-compaction-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, {
      // 1 通目の後で圧縮する (空の履歴は実 SDK でも圧縮しない)
      pi: createStubPi({ preflightCompactions: [null, { summary: "これまでの要約", summarizeCount: 1 }] }),
      workspace,
      catalog,
    });
    await store1.init();
    const record = await store1.create();
    store1.postMessage(record, "圧縮される会話");
    await waitFor(() => record.run?.status === "completed", 3000, "run completed");
    store1.postMessage(record, "圧縮後の会話");
    await waitFor(() => store1.statusOf(record) === "completed", 3000, "second run completed");
    await store1.flush(record);
    assert.equal(store1.payload(record).compactions.length, 1);

    const parsed = parseSessionFile(await readFile(sessionJsonlPath(record.id, storeDir), "utf8"), record.id);
    assert.equal(parsed.kind, "ok");
    if (parsed.kind === "ok") assert.ok(parsed.entries.some((entry) => entry.type === "compaction"));
    await store1.close();

    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    const payload = store2.payload(restored);
    assert.equal(payload.compactions.length, 1, "compaction entry を復元する");
    assert.equal(payload.compactions[0].summary, "これまでの要約");
    assert.equal(payload.compactions[0].tokensBefore, 68_000);
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("復元時のモデル能力に合わせて Effort を clamp する", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-effort-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const record = await store1.create();
    await store1.flush(record);
    await store1.close();

    // 推論レベル max を要求した履歴を作る
    const file = sessionJsonlPath(record.id, storeDir);
    const parsed = parseSessionFile(await readFile(file, "utf8"), record.id);
    assert.equal(parsed.kind, "ok");
    if (parsed.kind !== "ok") return;
    const last = parsed.entries[parsed.entries.length - 1];
    const thinking = {
      type: "thinking_level_change",
      id: "entry-thinking",
      parentId: (last?.id as string) ?? null,
      timestamp: new Date().toISOString(),
      thinkingLevel: "max",
    };
    await writeFile(file, serializeSession(parsed.header, [...parsed.entries, thinking]));

    // 非推論モデルで復元すると off へ補正される
    const pi2 = createStubPi({ availableModels: [STUB_PLAIN_MODEL], selectedModel: STUB_PLAIN_MODEL });
    const store2 = createStore(storeDir, { pi: pi2, workspace, catalog });
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    assert.equal(store2.payload(restored).thinkingLevel, "off");
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("ロードと DELETE が競合しても store を復活させない", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-race-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const record = await store1.create();
    await store1.flush(record);
    await store1.close();

    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store2.init();
    const results = await Promise.allSettled([store2.resolve(record.id), store2.deleteSession(record.id)]);
    assert.equal(results[1].status, "fulfilled");
    assert.equal(store2.list().length, 0);
    await assert.rejects(readFile(sessionMetaPath(record.id, storeDir), "utf8"));
    assert.equal(store2.status().dirty, 0);
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("保存中に DELETE しても store を復活させない", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-race-"));
  const { workspace } = stubWorkspace();
  try {
    const store = createStore(storeDir, { pi: createStubPi(), workspace });
    await store.init();
    const record = await store.create();
    const write = store.persist(record);
    const removed = store.deleteSession(record.id);
    await Promise.allSettled([write, removed]);
    assert.equal(await removed, true);
    assert.equal(store.list().length, 0);
    await assert.rejects(readFile(sessionMetaPath(record.id, storeDir), "utf8"));
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("sweep 中の同時 resolve は同じ record を共有する", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-sweep-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const created = await store1.create();
    await store1.flush(created);
    await store1.close();

    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store2.init();
    const live = await store2.resolve(created.id);
    assert.ok(live);
    live.lastUsedAt = Date.now() - 24 * 60 * 60 * 1000;

    const sweeping = store2.sweep();
    const first = store2.resolve(created.id);
    const second = store2.resolve(created.id);
    await sweeping;
    const [a, b] = await Promise.all([first, second]);
    assert.ok(a);
    assert.equal(a, b, "同じ record を共有する");
    assert.notEqual(a, live, "eviction 後は再ロードする");
    assert.equal(store2.status().dirty, 0);
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("プロジェクト解除は待機メッセージを破棄して実行しない", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-release-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const projects = new ProjectStore();
    const store = createStore(storeDir, {
      pi: createStubPi({ chunkDelayMs: 40 }),
      workspace,
      catalog,
      projects,
    });
    await store.init();
    const project = projects.create({ cwd: "proj-a" });
    const record = await store.create({ projectId: project.id });
    const stub = record.session as StubSession;
    store.postMessage(record, "実行中");
    await waitFor(() => record.run?.status === "running", 2000, "running");
    store.postMessage(record, "待機中");
    assert.equal(record.queue.length, 1);

    projects.remove(project.id);
    await store.releaseProject(project.cwd);
    assert.equal(record.queue.length, 0, "待機メッセージを破棄する");
    await waitFor(() => record.run?.status !== "running", 3000, "run settled");
    await new Promise((resolveTick) => setTimeout(resolveTick, 300));

    const userTexts = stub.messages.filter((message) => message.role === "user").map((message) => message.content);
    assert.deepEqual(userTexts, ["実行中"], "解除後に待機メッセージを実行しない");
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("保存に成功すると persistError が消える", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-persist-"));
  const { workspace } = stubWorkspace();
  try {
    const store = createStore(storeDir, { pi: createStubPi(), workspace });
    await store.init();
    const record = await store.create();

    // meta.json をディレクトリへ置き換えて rename を失敗させる
    const metaPath = sessionMetaPath(record.id, storeDir);
    await rm(metaPath, { force: true });
    await mkdir(metaPath, { recursive: true });
    await store.persist(record);
    assert.ok(record.persistError, "今回の失敗を記録する");
    assert.equal(store.status().dirty, 1);

    await rm(metaPath, { recursive: true, force: true });
    await store.persist(record);
    assert.equal(record.persistError, undefined, "成功で失敗を消す");
    assert.equal(store.status().dirty, 0);
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("設定変更中のセッションは sweep の対象外にする", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-sweep-"));
  const { workspace } = stubWorkspace();
  try {
    const store = createStore(storeDir, { pi: createStubPi(), workspace });
    await store.init();
    const record = await store.create();
    await store.flush(record);
    record.lastUsedAt = Date.now() - 24 * 60 * 60 * 1000;
    record.changingSettings = true;
    await store.sweep();
    assert.equal(store.get(record.id), record, "設定変更中は残す");
    record.changingSettings = false;
    await store.sweep();
    assert.equal(store.get(record.id), undefined);
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("プロジェクトを解除してもセッションと store は残り、未所属として解決される", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-project-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const projects = new ProjectStore();
    const store = createStore(storeDir, { pi: createStubPi(), workspace, catalog, projects });
    await store.init();
    const project = projects.create({ cwd: "proj-a" });
    const record = await store.create({ projectId: project.id });
    await store.flush(record);
    assert.equal(store.payload(record).projectId, project.id);

    projects.remove(project.id);
    await store.releaseProject(project.cwd);
    assert.equal(store.get(record.id), record, "セッションは live のまま残る");
    assert.equal(store.payload(record).projectId, undefined, "未所属として解決される");
    assert.equal((await readMeta(record.id, storeDir)).projectCwd, "proj-a", "所属の保存値は残す");
    // 同じ cwd を再登録すると、再起動をまたぐ場合と同じく所属が戻る
    const again = projects.create({ cwd: "proj-a" });
    assert.equal(store.payload(record).projectId, again.id);

    // 再起動後（新しい store）も保存値から所属を復元し、未登録なら未所属として解決する
    await store.flush(record);
    await store.close();
    const projects2 = new ProjectStore();
    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog, projects: projects2 });
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    assert.equal(store2.payload(restored).projectId, undefined, "未登録なら未所属");
    assert.equal(restored.workdir, "proj-a", "登録が無くても projectCwd をそのまま cwd に使う");
    projects2.create({ cwd: "proj-a" });
    assert.ok(store2.payload(restored).projectId, "再登録で所属が戻る");
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("store がワークスペース内ならセッション作成を拒否する", async () => {
  const { workspace } = stubWorkspace();
  const store = new SessionStore({
    pi: createStubPi() as never,
    catalog: createAgentCatalog(),
    storeDir: null,
    storeError: "PI_SESSION_STORE はワークスペースの外を指定してください",
    workspace,
    rootCwd: "/tmp/project",
  });
  await assert.rejects(store.create(), (error: Error & { statusCode?: number }) => {
    assert.equal(error.statusCode, 503);
    return true;
  });
  await store.close();
});

test("モデルの候補が無いときの復元は 503 になり、一覧からは消えない", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-nomodel-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const record = await store1.create();
    await store1.flush(record);
    await store1.close();

    // selectedModel も availableModels も無い = アプリ既定が無い状態を再現する
    const pi2 = createStubPi({ availableModels: [], selectedModel: null });
    const store2 = createStore(storeDir, { pi: pi2, workspace, catalog });
    await store2.init();
    assert.equal(store2.list().length, 1, "一覧には meta から出る");
    await assert.rejects(store2.resolve(record.id), (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 503);
      return true;
    });
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("sweep は購読者がいるセッションを破棄しない", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-sweep-"));
  const { workspace } = stubWorkspace();
  try {
    const store = createStore(storeDir, { pi: createStubPi(), workspace });
    await store.init();
    const record = await store.create();
    record.lastUsedAt = Date.now() - 24 * 60 * 60 * 1000;
    const unsubscribe = store.subscribe(record, undefined, () => {});
    await store.sweep();
    assert.equal(store.get(record.id), record, "購読中は残す");

    unsubscribe();
    await store.sweep();
    assert.equal(store.get(record.id), undefined, "購読解除後はメモリから外れる");
    // メモリから外れても store は残る
    assert.equal(store.list().length, 1);
    const restored = await store.resolve(record.id);
    assert.ok(restored);
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("persist は file の失敗を error に残し、次の保存で再試行できる", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-retry-"));
  const { workspace } = stubWorkspace();
  try {
    const store = createStore(storeDir, { pi: createStubPi(), workspace });
    await store.init();
    const record = await store.create();
    await store.flush(record);
    assert.equal(record.writer?.error, undefined);
    assert.equal((await readFile(sessionJsonlPath(record.id, storeDir), "utf8")).length > 0, true);
    assert.ok(STUB_MODEL.id);
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("プロジェクト所属セッションは登録ディレクトリを cwd にし、作成も復元も mkdir しない", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-project-cwd-"));
  const { workspace, dirs, listings } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const projects = new ProjectStore();
    const project = projects.create({ cwd: "repos/app" });
    const pi1 = createStubPi();
    const store1 = createStore(storeDir, { pi: pi1, workspace, catalog, projects });
    await store1.init();
    const record = await store1.create({ projectId: project.id });
    assert.equal(record.workdir, "repos/app", "cwd は登録ディレクトリそのもの");
    assert.equal(pi1.createInputs.at(-1)?.cwd, "repos/app", "SDK セッションへも同じ cwd を渡す");
    assert.deepEqual(listings, ["repos/app"], "存在確認だけを行う");
    assert.deepEqual(dirs, [], "プロジェクトのディレクトリは作らない");
    await store1.flush(record);

    // JSONL の header にも実際の cwd (絶対パス) が残る
    const file = await readFile(sessionJsonlPath(record.id, storeDir), "utf8");
    const parsed = parseSessionFile(file, record.id);
    assert.equal(parsed.kind, "ok");
    if (parsed.kind !== "ok") throw new Error("unreachable");
    assert.equal(parsed.header.cwd, "/tmp/project/repos/app");
    await store1.close();

    // 復元は meta.projectCwd から解決し、未登録でも同じディレクトリを使う (mkdir しない)
    const pi2 = createStubPi();
    const store2 = createStore(storeDir, { pi: pi2, workspace, catalog });
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    assert.equal(store2.payload(restored).cwd, "repos/app");
    assert.equal(pi2.createInputs.at(-1)?.cwd, "repos/app");
    assert.equal(restored.projectCwd, "repos/app");
    assert.equal(restored.projectId, undefined, "未登録なので所属は未解決");
    assert.deepEqual(dirs, [], "復元でもプロジェクトのディレクトリは作らない");
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("同一プロジェクトの別セッションは同じ作業ディレクトリを共有する", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-project-share-"));
  const { workspace, dirs } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const projects = new ProjectStore();
    const project = projects.create({ cwd: "repos/app" });
    const pi = createStubPi();
    const store = createStore(storeDir, { pi, workspace, catalog, projects });
    await store.init();
    const first = await store.create({ projectId: project.id });
    const second = await store.create({ projectId: project.id });
    assert.notEqual(first.id, second.id);
    assert.equal(store.payload(first).cwd, store.payload(second).cwd);
    assert.equal(store.payload(first).cwd, "repos/app");
    assert.deepEqual(dirs, [], "どちらのセッションもディレクトリを作らない");
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("未所属セッションは従来どおりスクラッチを作る", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-scratch-"));
  const { workspace, dirs } = stubWorkspace();
  try {
    const store = createStore(storeDir, { pi: createStubPi(), workspace });
    await store.init();
    const record = await store.create();
    assert.equal(record.workdir, `.u7agent/sessions/${record.id}`);
    assert.deepEqual(dirs, [record.workdir]);
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

// --- 応答メトリクスの復元 (アプリ DB) ---

test("restores the measured metrics from the app db and deletes them with the session", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-restore-metrics-"));
  const { workspace } = stubWorkspace();
  const appDb = AppDb.open({ storeDir });
  try {
    const catalog = createAgentCatalog();
    const store1 = createStore(storeDir, {
      pi: createStubPi({ chunkDelayMs: 5 }),
      workspace,
      catalog,
      assistantMetrics: appDb,
    });
    await store1.init();
    const record = await store1.create();
    store1.postMessage(record, "実測を残す");
    await waitFor(() => record.run?.status === "completed", 3000, "run completed");
    await store1.flush(record);
    // 保存は message_end の後に 1 拍外れる
    await waitFor(() => appDb.loadAssistantMetrics(record.id).length === 1, 3000, "metrics row");
    const live = store1.payload(record).messages[1]?.metrics;
    assert.ok(live, "live の応答時間は BFF が測る");
    await store1.close();

    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog, assistantMetrics: appDb });
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    const restoredMetrics = store2.payload(restored).messages[1]?.metrics;
    assert.deepEqual(restoredMetrics, live, "再起動後も同じ実測を出す");
    assert.equal(restoredMetrics?.source, undefined, "DB 実測は recorded ではない (≈ を付けない)");

    // セッションを削除すると行も消える
    assert.equal(await store2.deleteSession(record.id), true);
    assert.deepEqual(appDb.loadAssistantMetrics(record.id), []);
    await store2.close();
  } finally {
    appDb.close();
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("restores the response time from the app db even when the provider reported no usage", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-restore-metrics-no-usage-"));
  const { workspace } = stubWorkspace();
  const appDb = AppDb.open({ storeDir });
  try {
    const catalog = createAgentCatalog();
    const store1 = createStore(storeDir, {
      pi: createStubPi({ chunkDelayMs: 5, usage: null }),
      workspace,
      catalog,
      assistantMetrics: appDb,
    });
    await store1.init();
    const record = await store1.create();
    store1.postMessage(record, "usage 非対応のプロバイダ");
    await waitFor(() => record.run?.status === "completed", 3000, "run completed");
    await store1.flush(record);
    await waitFor(() => appDb.loadAssistantMetrics(record.id).length === 1, 3000, "metrics row");
    const [row] = appDb.loadAssistantMetrics(record.id);
    assert.equal(row.outputTokens, null, "未報告は NULL で保存する");
    assert.equal(row.ttftMs !== null, true, "TTFT は usage と独立に保存する");
    await store1.close();

    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog, assistantMetrics: appDb });
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    const metrics = store2.payload(restored).messages[1]?.metrics;
    assert.ok(metrics, "usage が無くても再起動後に応答時間が出る");
    assert.ok(metrics.durationMs > 0);
    assert.equal(metrics.ttftMs, row.ttftMs, "TTFT も復元する");
    assert.equal(Object.hasOwn(metrics, "tokensPerSecond"), false, "output が無いので tok/s は出さない (0 で埋めない)");
    await store2.close();
  } finally {
    appDb.close();
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("an old session without metrics rows opens as before", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-restore-metrics-legacy-"));
  const { workspace } = stubWorkspace();
  const appDb = AppDb.open({ storeDir });
  try {
    const catalog = createAgentCatalog();
    // 保存先を注入しない = 行を持たない旧セッションと同じ状態
    const store1 = createStore(storeDir, { pi: createStubPi({ chunkDelayMs: 1 }), workspace, catalog });
    await store1.init();
    const record = await store1.create();
    store1.postMessage(record, "行の無い会話");
    await waitFor(() => record.run?.status === "completed", 3000, "run completed");
    await store1.flush(record);
    await store1.close();
    assert.deepEqual(appDb.loadAssistantMetrics(record.id), []);

    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog, assistantMetrics: appDb });
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    const payload = store2.payload(restored);
    assert.deepEqual(
      payload.messages.map((message) => message.role),
      ["user", "assistant"],
      "行が無くても会話は開ける",
    );
    // SDK が durationMs を残していない履歴なので、従来どおり metrics は載らない
    assert.equal(payload.messages[1]?.metrics, undefined);
    await store2.close();
  } finally {
    appDb.close();
    await rm(storeDir, { recursive: true, force: true });
  }
});
