// investigate の契約: ツール（報告の切り詰め / details / isError / 打ち切り / mask）と runner（子の生成・
// 並列と待ち行列・親 stop・進捗）、子の過程が親の会話ストアに残らないことを検証する。
// 実モデルは呼ばず、スタブの pi セッションへイベントを流して確かめる。
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentCatalog } from "../src/agents";
import {
  INVESTIGATION_AGENT,
  INVESTIGATE_PROGRESS_TEXT_MAX,
  createInvestigateRunner,
  type InvestigateChildInput,
  type InvestigateRunner,
} from "../src/investigate-runner";
import {
  INVESTIGATE_REPORT_MAX,
  createInvestigateToolDefinitions,
  type InvestigateHost,
  type InvestigateProgress,
} from "../src/investigate-tool";
import { REDACTED, createSecretMasker, type SecretMasker } from "../src/redact";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import { SessionStore } from "../src/sessions";
import { sessionJsonlPath } from "../src/session-store";
import { contentText } from "../src/session-projection";
import { STUB_USAGE, createStubPi, createStubSession, waitFor, type StubSession } from "./stub-pi";

interface ToolResult {
  content: { type: string; text?: string }[];
  details?: {
    outcome?: string;
    toolCalls?: number;
    compactions?: number;
    usage?: unknown;
  };
  isError?: boolean;
}

function toolText(result: ToolResult): string {
  return result.content.map((part) => part.text ?? "").join("");
}

function runTool(
  host: InvestigateHost,
  prompt: string,
  options: { timeoutMs?: number; masker?: SecretMasker; signal?: AbortSignal; onUpdate?: (text: string) => void } = {},
): Promise<ToolResult> {
  const definition = createInvestigateToolDefinitions({
    enabled: true,
    sessionId: "s-1",
    host,
    masker: options.masker ?? createSecretMasker([]),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: () => options.timeoutMs as number }),
  })[0];
  const onUpdate = options.onUpdate
    ? (partial: { content: { type: string; text: string }[] }) => options.onUpdate?.(contentText(partial.content))
    : undefined;
  return definition.execute(
    "call-1",
    { prompt },
    options.signal,
    onUpdate as never,
    {} as never,
  ) as unknown as Promise<ToolResult>;
}

/** 子セッションを差し替え可能にした runner。作られた子と入力は検証のために残す */
function createHarness(
  options: {
    reply?: string;
    chunkDelayMs?: number;
    masker?: SecretMasker;
    /** 子セッションをテスト側で差し替える (SDK の異常終了などを再現する) */
    patchSession?: (session: StubSession) => void;
  } = {},
) {
  const inputs: InvestigateChildInput[] = [];
  const sessions: StubSession[] = [];
  const runner = createInvestigateRunner({
    masker: options.masker ?? createSecretMasker([]),
    progressIntervalMs: 0,
    createChildSession: async (input) => {
      inputs.push(input);
      const session = createStubSession({
        reply: options.reply ?? "子の報告",
        chunkDelayMs: options.chunkDelayMs ?? 0,
      });
      options.patchSession?.(session);
      sessions.push(session);
      return session;
    },
  });
  return { runner, inputs, sessions };
}

/** runner をツールの host として使う (子は harness のスタブ) */
function runnerHost(runner: InvestigateRunner): InvestigateHost {
  return {
    investigate: (request) =>
      runner.investigate({
        sessionId: request.sessionId,
        cwd: "proj",
        prompt: request.prompt,
        signal: request.signal,
        ...(request.onProgress ? { onProgress: request.onProgress } : {}),
      }),
  };
}

function assistantText(session: StubSession): string {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message.role === "assistant") return contentText(message.content);
  }
  return "";
}

function stubWorkspace(): SandboxWorkspaceClient {
  return {
    previewFile: async () => ({ text: "" }),
    listFiles: async (path: string) => ({ path: path || ".", entries: [], truncated: false }),
    getGitInfo: async () => ({ branch: null }),
    listSkills: async () => ({ skills: [] }),
    createDir: async (path: string) => ({ path }),
    renameEntry: async (path: string, name: string) => ({ path, name }),
    deleteFile: async () => {},
    deleteDirectory: async () => {},
    uploadFile: async ({ name }) => ({ path: `uploads/${name}`, name, renamed: false, size: 0 }),
    rawFile: async () => ({ contentType: "image/png", body: null }),
    downloadEntry: async () => ({
      contentType: "application/octet-stream",
      contentDisposition: "attachment",
      body: null,
    }),
    checkDownload: async () => ({ kind: "file", name: "a.txt", entries: 0, bytes: 0, skipped: [] }),
  };
}

test("investigate は 1 引数の prompt だけを受け付け、code mode からは呼ばせない", () => {
  const definition = createInvestigateToolDefinitions({
    enabled: true,
    sessionId: "s-1",
    host: { investigate: async () => ({ outcome: "completed", report: "", toolCalls: 0 }) },
    masker: createSecretMasker([]),
  })[0];
  assert.equal(definition.name, "investigate");
  assert.equal(definition.exposure, "model-only");
  assert.deepEqual((definition.parameters as { required?: string[] }).required, ["prompt"]);
  assert.deepEqual(Object.keys((definition.parameters as { properties: object }).properties), ["prompt"]);
  // 無効 / 会話 id 未束縛では公開しない (ask_user と同じ扱い)
  assert.equal(
    createInvestigateToolDefinitions({
      enabled: false,
      sessionId: "s-1",
      host: { investigate: async () => ({ outcome: "completed", report: "", toolCalls: 0 }) },
      masker: createSecretMasker([]),
    }).length,
    0,
  );
  assert.equal(
    createInvestigateToolDefinitions({
      enabled: true,
      host: { investigate: async () => ({ outcome: "completed", report: "", toolCalls: 0 }) },
      masker: createSecretMasker([]),
    }).length,
    0,
  );
});

test("報告を details つきで返し、上限を超える報告は切り詰める", async () => {
  const report = "結".repeat(INVESTIGATE_REPORT_MAX + 500);
  const result = await runTool(
    { investigate: async () => ({ outcome: "completed", report, toolCalls: 4, usage: STUB_USAGE }) },
    "調べて",
  );
  assert.equal(result.isError, undefined);
  assert.equal(toolText(result).length, INVESTIGATE_REPORT_MAX + 1);
  assert.ok(toolText(result).endsWith("…"));
  assert.deepEqual(result.details, { outcome: "completed", toolCalls: 4, usage: STUB_USAGE });

  const short = await runTool(
    { investigate: async () => ({ outcome: "completed", report: "結論: A にある", toolCalls: 1, compactions: 2 }) },
    "調べて",
  );
  assert.equal(toolText(short), "結論: A にある");
  assert.deepEqual(short.details, { outcome: "completed", toolCalls: 1, compactions: 2 });

  // 空の prompt だけは throw する (残すデータが無く、モデルにやり直させる)
  const definition = createInvestigateToolDefinitions({
    enabled: true,
    sessionId: "s-1",
    host: { investigate: async () => ({ outcome: "completed", report: "", toolCalls: 0 }) },
    masker: createSecretMasker([]),
  })[0];
  await assert.rejects(
    definition.execute("call-1", { prompt: "  " }, undefined, undefined, {} as never),
    /prompt が空/,
  );
});

test("子セッションを作れないときも isError と details を返す", async () => {
  const result = await runTool(
    {
      investigate: async () => {
        const error = new Error("Model is not available: stub/stub-model") as Error & { statusCode?: number };
        error.statusCode = 400;
        throw error;
      },
    },
    "調べて",
  );
  assert.equal(result.isError, true);
  assert.match(toolText(result), /子エージェントの実行に失敗しました/);
  assert.match(toolText(result), /Model is not available/);
  assert.deepEqual(result.details, { outcome: "error", toolCalls: 0 });
});

test("報告の秘密値は mask して返す", async () => {
  const secret = "sk-live-secret-value";
  const result = await runTool(
    { investigate: async () => ({ outcome: "completed", report: `トークン: ${secret}`, toolCalls: 1 }) },
    "調べて",
    { masker: createSecretMasker([secret]) },
  );
  assert.equal(toolText(result), `トークン: ${REDACTED}`);
});

test("切り詰めの境界に掛かる秘密値も成功・部分報告の両方で漏らさない", async () => {
  const secret = "sk-real-long-secret-value";
  const report = `${"x".repeat(INVESTIGATE_REPORT_MAX - secret.length + 1)}${secret}${"y".repeat(50)}`;
  const completed = await runTool(
    { investigate: async () => ({ outcome: "completed", report, toolCalls: 1 }) },
    "調べて",
    { masker: createSecretMasker([secret]) },
  );
  assert.equal(completed.isError, undefined);
  assert.ok(!toolText(completed).includes(secret));
  assert.ok(!toolText(completed).includes(secret.slice(0, 8)));
  assert.ok(toolText(completed).includes(REDACTED));
  assert.equal(toolText(completed).length, INVESTIGATE_REPORT_MAX + 1);

  const aborted = await runTool({ investigate: async () => ({ outcome: "aborted", report, toolCalls: 1 }) }, "調べて", {
    masker: createSecretMasker([secret]),
  });
  assert.equal(aborted.isError, true);
  assert.ok(!toolText(aborted).includes(secret));
  assert.ok(!toolText(aborted).includes(secret.slice(0, 8)));
});

test("進捗は onUpdate へ活動と本文をそのまま渡す", async () => {
  const seen: string[] = [];
  await runTool(
    {
      investigate: async (request) => {
        request.onProgress?.({ activity: "grep TODO", text: "調査中です" });
        return { outcome: "completed", report: "done", toolCalls: 1 };
      },
    },
    "調べて",
    { onUpdate: (text) => seen.push(text) },
  );
  assert.deepEqual(seen, ["grep TODO\n調査中です"]);
});

test("子は親と同じ cwd とモデルで、調査用 agent を使って作る", async () => {
  const { runner, inputs, sessions } = createHarness({ reply: "結論: A にある" });
  const result = await runner.investigate({
    sessionId: "s-1",
    cwd: "proj",
    model: { provider: "stub", id: "stub-model" },
    prompt: "どこにある？",
    signal: new AbortController().signal,
  });
  assert.equal(result.outcome, "completed");
  assert.equal(result.report, "結論: A にある");
  assert.equal(result.toolCalls, 0);
  assert.deepEqual(result.usage, STUB_USAGE);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].ownerSessionId, "s-1");
  assert.equal(inputs[0].cwd, "proj");
  assert.deepEqual(inputs[0].model, { provider: "stub", id: "stub-model" });
  assert.equal(inputs[0].agent, INVESTIGATION_AGENT);
  assert.deepEqual(inputs[0].agent.skillIds, []);
  // 子には依頼本文と報告の順序を渡し、終了後は購読とセッションを閉じる
  assert.match(String(sessions[0].messages[0]?.content), /どこにある？/);
  assert.match(String(sessions[0].messages[0]?.content), /conclusion, then the evidence/);
  assert.equal(sessions[0].disposed, true);
});

test("子セッションを作れないときは outcome error になる", async () => {
  const runner = createInvestigateRunner({
    masker: createSecretMasker([]),
    createChildSession: async () => {
      throw new Error("子を作れません");
    },
  });
  const result = await runner.investigate({
    sessionId: "s-1",
    cwd: "",
    prompt: "調べて",
    signal: new AbortController().signal,
  });
  assert.deepEqual(result, { outcome: "error", report: "", toolCalls: 0 });
});

test("進捗は活動と本文末尾だけを間引いて渡し、秘密値を mask する", async () => {
  const secret = "sk-progress-secret";
  const reply = ["結論です", `${secret} を見つけました`, "x".repeat(120), "y".repeat(120), "最後の行"].join("\n");
  const { runner, sessions } = createHarness({ reply, chunkDelayMs: 20, masker: createSecretMasker([secret]) });
  const progress: InvestigateProgress[] = [];
  const pending = runner.investigate({
    sessionId: "s-1",
    cwd: "",
    prompt: "調べて",
    signal: new AbortController().signal,
    onProgress: (item) => progress.push(item),
  });
  await waitFor(() => sessions.length === 1, 3000, "child session");
  sessions[0].emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "grep", args: { path: "src/a.ts" } });
  await pending;
  assert.ok(
    progress.some((item) => item.activity === "grep src/a.ts"),
    JSON.stringify(progress),
  );
  for (const item of progress) {
    assert.ok(item.text.length <= INVESTIGATE_PROGRESS_TEXT_MAX, JSON.stringify(item));
    assert.ok(item.text.split("\n").length <= 3, JSON.stringify(item));
    assert.ok(!item.text.includes(secret));
  }
  // 末尾 3 行が 200 文字を超えるときは末尾側を残す
  const last = progress.at(-1);
  assert.ok(last);
  assert.equal(last.text.length, INVESTIGATE_PROGRESS_TEXT_MAX);
  assert.ok(last.text.endsWith(reply.slice(reply.length - 50)));
});

test("タイムアウトでは子を止め、受信済みの部分報告と理由を isError で返す", async () => {
  const partial = "ここまでの調査結果";
  const { runner, sessions } = createHarness({
    // 本文を 1 回流したまま解決しない (timeout は本文が届いた後に発火する)
    patchSession: (session) => {
      session.prompt = () => {
        session.isStreaming = true;
        session.emit({ type: "message_start", message: { role: "assistant" } });
        session.appendMessage({ role: "assistant", content: [{ type: "text", text: partial }] });
        session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: partial } });
        return new Promise(() => {});
      };
    },
  });
  const result = await runTool(runnerHost(runner), "調べて", { timeoutMs: 20 });
  assert.equal(result.isError, true);
  assert.match(toolText(result), /時間切れで打ち切りました/);
  assert.match(toolText(result), new RegExp(partial));
  assert.equal(result.details?.outcome, "timeout");
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].abortRequested, true);
});

test("子の最後の assistant が stopReason error なら isError と outcome error を返す", async () => {
  const { runner } = createHarness({
    // SDK は provider の失敗や retry 枯渇を最後の assistant の stopReason に載せ、prompt() は resolve する
    patchSession: (session) => {
      session.prompt = async () => {
        session.emit({ type: "message_start", message: { role: "assistant" } });
        session.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: "調査の途中で失敗しました" }],
          stopReason: "error",
          errorMessage: "401 unauthorized",
        });
        session.emit({ type: "message_end", message: { role: "assistant" } });
        session.emit({ type: "agent_settled" });
      };
    },
  });
  const result = await runTool(runnerHost(runner), "調べて");
  assert.equal(result.isError, true);
  assert.match(toolText(result), /子エージェントの実行に失敗しました/);
  assert.match(toolText(result), /調査の途中で失敗しました/);
  assert.equal(result.details?.outcome, "error");
});

test("親の stop では子を止め、部分報告と理由を isError で返す", async () => {
  const { runner, sessions } = createHarness({ reply: "ここまでの調査結果", chunkDelayMs: 200 });
  const controller = new AbortController();
  const pending = runTool(runnerHost(runner), "調べて", { signal: controller.signal });
  await waitFor(() => sessions.length === 1, 3000, "child session");
  await waitFor(() => assistantText(sessions[0]) !== "", 3000, "first child chunk");
  controller.abort();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(toolText(result), /停止しました/);
  assert.match(toolText(result), /ここま/);
  assert.equal(result.details?.outcome, "aborted");
  assert.equal(sessions[0].abortRequested, true);
  assert.equal(sessions[0].disposed, true);
});

test("並列は会話ごとに 3 件までで、4 件目は空きを待つ", async () => {
  const { runner, inputs } = createHarness({ chunkDelayMs: 30 });
  const controller = new AbortController();
  const calls = [0, 1, 2, 3].map((index) =>
    runner.investigate({ sessionId: "s-1", cwd: "", prompt: `q${index}`, signal: controller.signal }),
  );
  await waitFor(() => inputs.length === 3, 3000, "3 children start");
  assert.equal(inputs.length, 3);
  const results = await Promise.all(calls);
  assert.equal(inputs.length, 4);
  assert.equal(inputs[3].ownerSessionId, "s-1");
  assert.deepEqual(
    results.map((result) => result.outcome),
    ["completed", "completed", "completed", "completed"],
  );
});

test("親の stop は待機中の呼び出しも開始させずに終わらせる", async () => {
  const { runner, inputs, sessions } = createHarness({ chunkDelayMs: 200 });
  const controller = new AbortController();
  const calls = [0, 1, 2, 3].map((index) =>
    runner.investigate({ sessionId: "s-1", cwd: "", prompt: `q${index}`, signal: controller.signal }),
  );
  await waitFor(() => inputs.length === 3, 3000, "3 children start");
  controller.abort();
  const results = await Promise.all(calls);
  assert.deepEqual(
    results.map((result) => result.outcome),
    ["aborted", "aborted", "aborted", "aborted"],
  );
  assert.equal(inputs.length, 3);
  assert.ok(sessions.every((session) => session.abortRequested));
});

test("子の過程は親の会話ストアに残らない", async () => {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-investigate-"));
  const pi = createStubPi({ reply: "親の応答" });
  const store = new SessionStore({
    pi: pi as never,
    catalog: createAgentCatalog(),
    storeDir: dir,
    workspace: stubWorkspace(),
    rootCwd: "/tmp/project",
  });
  try {
    const record = await store.create();
    store.postMessage(record, "調べて");
    await waitFor(() => store.statusOf(record) === "completed", 3000, "parent run");
    await store.persist(record);
    const before = {
      tree: (await readdir(dir, { recursive: true })).sort(),
      jsonl: await readFile(sessionJsonlPath(record.id, dir), "utf8"),
    };

    const result = await store.investigateHost().investigate({
      sessionId: record.id,
      toolCallId: "call-1",
      prompt: "どこにある？",
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, "completed");
    assert.equal(result.report, "親の応答");

    // 子は record にも JSONL にも載らない (親のストアは 1 件のまま、ファイルも本文も変わらない)
    assert.equal(store.size, 1);
    assert.equal(pi.createInputs.length, 2);
    assert.equal(pi.createInputs[1].mode, "investigation");
    assert.equal(pi.createInputs[1].sessionId, undefined);
    assert.equal(pi.createInputs[1].entries, undefined);
    assert.deepEqual((await readdir(dir, { recursive: true })).sort(), before.tree);
    const after = await readFile(sessionJsonlPath(record.id, dir), "utf8");
    assert.equal(after, before.jsonl);
    assert.ok(!after.includes("どこにある？"));
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
