// ask_user の契約: パラメータ検証 / 質問と回答の導出 / 待機のライフサイクル / DTO と履歴の復元 / mask。
// ランタイムはスタブの pi セッションへイベントを直接 emit して検証する (実モデルは呼ばない)。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentCatalog } from "../src/agents";
import { createBffApp } from "../src/app";
import {
  createAskUserToolDefinitions,
  deriveAskUserQuestions,
  formatAskUserAnswers,
  parseAskUserAnswers,
  validateAskUserAnswers,
  validateAskUserQuestions,
  type AskUserHost,
} from "../src/ask-user-tool";
import { createSecretMasker, REDACTED } from "../src/redact";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import type { AskUserAnswer, AskUserQuestion, EventEntry, MessageMetrics, ToolCall } from "../src/schema";
import { projectMessages } from "../src/session-projection";
import {
  SessionStore,
  type PiRuntimeLike,
  type PiSessionEvent,
  type PiSessionEventListener,
  type PiSessionLike,
} from "../src/sessions";
import { asPiBff, createStubPi, waitFor } from "./stub-pi";

const CWD = "/tmp/project";
const noMetrics = () => new WeakMap<object, MessageMetrics>();

const QUESTIONS: AskUserQuestion[] = [
  {
    question: "どちらの方式で進めますか",
    header: "方式",
    options: [{ label: "A 案", description: "小さく始める" }, { label: "B 案" }],
  },
  { question: "補足はありますか", type: "text", placeholder: "任意" },
];

function askCall(id: string, questions: unknown): unknown {
  return { type: "toolCall", id, name: "ask_user", arguments: { questions } };
}

function toolResult(id: string, details: unknown, isError = false): PiSessionLike["messages"][number] {
  return {
    role: "toolResult",
    content: [{ type: "text", text: "ユーザーの回答:" }],
    toolCallId: id,
    isError,
    details,
    timestamp: 3,
  };
}

function text(value: string): unknown {
  return { type: "text", text: value };
}

interface ScriptedSession extends PiSessionLike {
  emit(event: PiSessionEvent): void;
}

/** スクリプトを prompt() の中で一度だけ走らせる最小セッション */
function createScriptedSession(run: (session: ScriptedSession) => void): ScriptedSession {
  const listeners = new Set<PiSessionEventListener>();
  const session = {
    sessionId: "pi-ask-user",
    model: { provider: "stub", id: "stub-model" },
    thinkingLevel: "low",
    messages: [] as PiSessionLike["messages"],
    isStreaming: false,
    disposed: false,
    get isIdle() {
      return !session.isStreaming;
    },
    supportsThinking: () => true,
    getAvailableThinkingLevels: () => ["low"],
    setThinkingLevel() {},
    async setModel() {},
    subscribe(listener: PiSessionEventListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: PiSessionEvent) {
      for (const listener of listeners) listener(event);
    },
    async abort() {},
    dispose() {
      session.disposed = true;
    },
    async prompt() {
      session.isStreaming = true;
      try {
        run(session as unknown as ScriptedSession);
      } finally {
        session.isStreaming = false;
      }
    },
  };
  return session as unknown as ScriptedSession;
}

/** 待機中に止める検証用。prompt() が解決しないまま isStreaming を立て続ける */
function createPendingSession(): ScriptedSession {
  const session = createScriptedSession(() => {});
  session.prompt = () => {
    session.isStreaming = true;
    return new Promise(() => {});
  };
  // 手動圧縮の 501 ガードを先に通し、busy 判定 (409) を検証できるようにする
  (session as { compact?: unknown }).compact = async () => ({});
  return session;
}

function createStore(session: PiSessionLike, masker = createSecretMasker([])): SessionStore {
  return new SessionStore({
    pi: { createSession: async () => ({ session }) } as unknown as PiRuntimeLike,
    catalog: createAgentCatalog(),
    masker,
    rootCwd: CWD,
  });
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
    checkDownload: async () => ({ kind: "file", name: "a.txt", bytes: 0, entries: 0, skipped: [] }),
  };
}

test("パラメータ検証は上限違反を 1 文で返し、正しい質問は通す", () => {
  assert.equal(validateAskUserQuestions(QUESTIONS), undefined);

  const dedupe = (overrides: Partial<AskUserQuestion>): AskUserQuestion[] => [{ question: "q", ...overrides }];
  assert.match(validateAskUserQuestions([]) ?? "", /1 to 4/);
  assert.match(validateAskUserQuestions(Array.from({ length: 5 }, () => ({ question: "q" }))) ?? "", /1 to 4/);
  assert.match(validateAskUserQuestions(dedupe({ question: "x".repeat(501) })) ?? "", /question must be at most 500/);
  assert.match(validateAskUserQuestions(dedupe({ header: "x".repeat(41) })) ?? "", /header must be at most 40/);
  assert.match(
    validateAskUserQuestions(dedupe({ options: Array.from({ length: 7 }, (_, index) => ({ label: `o${index}` })) })) ??
      "",
    /at most 6 items/,
  );
  assert.match(
    validateAskUserQuestions(dedupe({ options: [{ label: "x".repeat(81) }] })) ?? "",
    /label must be at most 80/,
  );
  assert.match(
    validateAskUserQuestions(dedupe({ options: [{ label: "a", description: "x".repeat(201) }] })) ?? "",
    /description must be at most 200/,
  );
});

test("引数から質問を導出し、前後の空白だけ落として表示に使う", () => {
  assert.deepEqual(deriveAskUserQuestions({ questions: [{ question: "  q  ", header: " ", options: [] }] }), [
    { question: "q" },
  ]);
  assert.deepEqual(
    deriveAskUserQuestions({
      questions: [
        { question: "q", type: "choice", multiSelect: true, placeholder: " p ", options: [{ label: " a " }] },
      ],
    }),
    [{ question: "q", type: "choice", multiSelect: true, placeholder: "p", options: [{ label: "a" }] }],
  );
  // 上限違反・壊れた形は「カードを出さない」に寄せる (汎用ツール履歴のエラーとして見せる)
  assert.equal(deriveAskUserQuestions({ questions: [{ question: "" }] }), undefined);
  assert.equal(deriveAskUserQuestions({ questions: [{ question: "q", type: "unknown" }] }), undefined);
  assert.equal(deriveAskUserQuestions({ questions: Array.from({ length: 5 }, () => ({ question: "q" })) }), undefined);
  assert.equal(deriveAskUserQuestions({ questions: "q" }), undefined);
});

test("回答の検証は全質問の網羅と skipped の排他を要求する", () => {
  assert.equal(
    validateAskUserAnswers(QUESTIONS, [
      { index: 0, selected: ["A"] },
      { index: 1, text: "はい" },
    ]),
    undefined,
  );
  assert.equal(
    validateAskUserAnswers(QUESTIONS, [
      { index: 0, selected: ["A"], text: "補足" },
      { index: 1, skipped: true },
    ]),
    undefined,
  );

  assert.match(validateAskUserAnswers(QUESTIONS, [{ index: 0, selected: ["A"] }]) ?? "", /cover every question/);
  assert.match(
    validateAskUserAnswers(QUESTIONS, [
      { index: 0, selected: ["A"] },
      { index: 2, text: "x" },
    ]) ?? "",
    /out of range/,
  );
  assert.match(
    validateAskUserAnswers(QUESTIONS, [
      { index: 0, selected: ["A"] },
      { index: 0, text: "x" },
    ]) ?? "",
    /duplicated/,
  );
  assert.match(
    validateAskUserAnswers(QUESTIONS, [
      { index: 0, skipped: true, text: "x" },
      { index: 1, text: "y" },
    ]) ?? "",
    /skipped cannot/,
  );
  assert.match(
    validateAskUserAnswers(QUESTIONS, [{ index: 0 }, { index: 1, text: " " }]) ?? "",
    /needs selected or text/,
  );
});

test("モデル向け text は質問順に選択・自由記入・回答なしを並べる", () => {
  const text = formatAskUserAnswers(QUESTIONS, [
    { index: 1, skipped: true },
    { index: 0, selected: ["A 案", "B 案"], text: "両方試したい" },
  ]);
  assert.equal(
    text,
    [
      "ユーザーの回答:",
      "1. どちらの方式で進めますか",
      "   - 選択: A 案, B 案",
      "   - 自由記入: 両方試したい",
      "2. 補足はありますか",
      "   - 回答なし（ユーザーは「回答しない」を選択）",
      "回答が得られました。同じ内容を質問し直さず、作業を続けてください。",
    ].join("\n"),
  );
  // 回答が欠けた質問も「回答なし」として出す (モデルへ空欄を渡さない)
  assert.match(formatAskUserAnswers([{ question: "q" }], []), /回答なし/);
});

test("toolResult の details から回答を復元し、空配列は回答なしとして残す", () => {
  assert.deepEqual(
    parseAskUserAnswers({
      questions: QUESTIONS,
      answers: [
        { index: 1, text: "  " },
        { index: 0, selected: ["A", ""] },
      ],
    }),
    [{ index: 0, selected: ["A"] }, { index: 1 }],
  );
  assert.deepEqual(parseAskUserAnswers({ questions: QUESTIONS, answers: [] }), []);
  assert.equal(parseAskUserAnswers({ questions: QUESTIONS }), undefined);
  assert.equal(parseAskUserAnswers({ answers: [{ index: "0" }] }), undefined);
});

test("execute は回答を details に載せ、中止では isError と空の回答を返す", async () => {
  const answered = createAskUserToolDefinitions({
    enabled: true,
    sessionId: "s-1",
    host: {
      ask: async () => [
        { index: 0, selected: ["A 案"] },
        { index: 1, skipped: true },
      ],
    },
  })[0];
  const result = (await answered.execute("call-1", { questions: QUESTIONS }, undefined, undefined, {} as never)) as {
    content: { type: string; text?: string }[];
    details: { answers: AskUserAnswer[] };
  };
  assert.match(result.content[0]?.text ?? "", /1\. どちらの方式で進めますか/);
  assert.deepEqual(result.details.answers, [
    { index: 0, selected: ["A 案"] },
    { index: 1, skipped: true },
  ]);

  // 中止 (host の reject) は throw しない。details を残さないと停止後の再読込でカードを復元できない
  const aborted = createAskUserToolDefinitions({
    enabled: true,
    sessionId: "s-1",
    host: { ask: async () => Promise.reject(new Error("aborted")) },
  })[0];
  const failure = (await aborted.execute("call-1", { questions: QUESTIONS }, undefined, undefined, {} as never)) as {
    content: { type: string; text?: string }[];
    details: { questions: AskUserQuestion[]; answers: AskUserAnswer[] };
    isError?: boolean;
  };
  assert.equal(failure.isError, true);
  assert.equal(failure.content[0]?.text, "回答が得られないまま停止しました");
  assert.deepEqual(failure.details.answers, []);
  assert.deepEqual(failure.details.questions, QUESTIONS);

  // 検証の失敗だけは throw する (残すデータが無く、モデルにやり直させる)
  await assert.rejects(
    answered.execute("call-1", { questions: [] }, undefined, undefined, {} as never),
    /ask_user のパラメータが不正です/,
  );
});

test("回答は 1 回だけ成立し、2 回目は answered / 未知の id は missing になる", async () => {
  const store = createStore(createScriptedSession(() => {}));
  try {
    const record = await store.create();
    const host = store.askUserHost();
    const pending = host.ask(record.id, "call-1", QUESTIONS, undefined);

    assert.equal(store.answerQuestion(record, "call-1", [{ index: 0, selected: ["A"] }]).status, "invalid");
    assert.equal(
      store.answerQuestion(record, "call-1", [{ index: 0, selected: ["A"] }, { index: 1 }]).status,
      "invalid",
    );
    assert.equal(
      store.answerQuestion(record, "call-1", [
        { index: 0, selected: ["A"] },
        { index: 1, skipped: true },
      ]).status,
      "ok",
    );
    assert.deepEqual(
      await pending,
      [
        { index: 0, selected: ["A"] },
        { index: 1, skipped: true },
      ],
      "回答は質問順に揃う",
    );

    // tombstone が残るので、2 タブ目の回答は「回答済み」で弾ける
    assert.equal(
      store.answerQuestion(record, "call-1", [
        { index: 0, selected: ["B"] },
        { index: 1, text: "x" },
      ]).status,
      "answered",
    );
    assert.equal(store.answerQuestion(record, "call-x", [{ index: 0 }, { index: 1 }]).status, "missing");
  } finally {
    await store.close();
  }
});

test("abort された待機は取り消され、同じ id へは回答できない", async () => {
  const store = createStore(createScriptedSession(() => {}));
  try {
    const record = await store.create();
    const controller = new AbortController();
    const pending = store.askUserHost().ask(record.id, "call-1", QUESTIONS, controller.signal);
    controller.abort();
    await assert.rejects(pending);
    assert.equal(
      store.answerQuestion(record, "call-1", [
        { index: 0, selected: ["A"] },
        { index: 1, skipped: true },
      ]).status,
      "missing",
    );
  } finally {
    await store.close();
  }
});

test("stop と delete は未回答の待機を取り消し、回答を受け付けない", async () => {
  const running = createPendingSession();
  const store = createStore(running);
  try {
    const record = await store.create();
    store.postMessage(record, "聞いて");
    await waitFor(() => store.statusOf(record) === "running", 1000, "run start");

    const stopped = store.askUserHost().ask(record.id, "call-1", QUESTIONS, undefined);
    await store.stop(record);
    await assert.rejects(stopped, /ask_user/);
    assert.equal(
      store.answerQuestion(record, "call-1", [
        { index: 0, selected: ["A"] },
        { index: 1, skipped: true },
      ]).status,
      "missing",
    );

    const deleted = store.askUserHost().ask(record.id, "call-2", QUESTIONS, undefined);
    await store.deleteSession(record.id);
    await assert.rejects(deleted, /ask_user/);
  } finally {
    await store.close();
  }
});

test("tool_start / tool_end と payload・履歴が同じ質問と回答を配る", async () => {
  const args = { questions: QUESTIONS };
  const answers: AskUserAnswer[] = [
    { index: 0, selected: ["A 案"], text: "補足" },
    { index: 1, skipped: true },
  ];
  const session = createScriptedSession((s) => {
    s.emit({ type: "agent_start" });
    const asked = {
      role: "assistant",
      content: [text("確認します"), askCall("call-1", QUESTIONS)],
      stopReason: "stop",
      timestamp: 1,
    };
    s.messages.push(asked);
    s.emit({ type: "message_end", message: asked });
    s.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "ask_user", args });
    s.emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "ask_user",
      isError: false,
      result: { content: [{ type: "text", text: "ユーザーの回答:" }], details: { questions: QUESTIONS, answers } },
    });
    s.messages.push(toolResult("call-1", { questions: QUESTIONS, answers }));
    const done = { role: "assistant", content: [text("続けます")], stopReason: "stop", timestamp: 4 };
    s.messages.push(done);
    s.emit({ type: "message_end", message: done });
    s.emit({ type: "agent_settled" });
  });
  const store = createStore(session);
  try {
    const record = await store.create();
    const events: EventEntry[] = [];
    store.subscribe(record, undefined, (entry) => events.push(entry));
    store.postMessage(record, "聞いて");
    await waitFor(() => store.statusOf(record) === "completed", 1000, "run completion");

    const toolStart = events.find((entry) => entry.type === "tool_start");
    assert.deepEqual(toolStart?.data.questions, QUESTIONS, "tool_start は質問を載せる");
    const questionStatus = events.find(
      (entry): entry is Extract<EventEntry, { type: "status" }> =>
        entry.type === "status" && entry.data.state === "question",
    );
    assert.equal(questionStatus?.data.text, "回答を待っています…");
    const toolEnd = events.find((entry) => entry.type === "tool_end");
    assert.deepEqual(toolEnd?.data.answers, answers, "tool_end は回答を載せる");

    // reload / SSE 再接続の正は payload。スキルと違い、質問と回答は ToolCall に載る
    const payload = store.payload(record);
    const live: ToolCall | undefined = payload.run?.toolCalls[0];
    assert.deepEqual(live?.questions, QUESTIONS);
    assert.deepEqual(live?.answers, answers);

    // 履歴も toolResult の details から同じ値を復元する
    const history = payload.messages.flatMap((message) => message.tools ?? []);
    assert.deepEqual(
      history.map((call) => call.questions),
      [QUESTIONS],
    );
    assert.deepEqual(
      history.map((call) => call.answers),
      [answers],
    );
  } finally {
    await store.close();
  }
});

test("停止で回答なしになった結果は details から「回答なしで終了」として復元できる", async () => {
  const args = { questions: QUESTIONS };
  const session = createScriptedSession((s) => {
    s.emit({ type: "agent_start" });
    const asked = {
      role: "assistant",
      content: [text("確認します"), askCall("call-1", QUESTIONS)],
      stopReason: "aborted",
      timestamp: 1,
    };
    s.messages.push(asked);
    s.emit({ type: "message_end", message: asked });
    s.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "ask_user", args });
    // 停止時は execute が isError + answers: [] を返し、それを toolResult が保存する
    const details = { questions: QUESTIONS, answers: [] };
    s.emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "ask_user",
      isError: true,
      result: { content: [{ type: "text", text: "回答が得られないまま停止しました" }], details },
    });
    s.messages.push(toolResult("call-1", details, true));
    s.emit({ type: "agent_settled" });
  });
  const store = createStore(session);
  try {
    const record = await store.create();
    store.postMessage(record, "聞いて");
    await waitFor(() => store.statusOf(record) !== "running", 1000, "run end");
    const payload = store.payload(record);
    assert.deepEqual(
      payload.messages.flatMap((message) => message.tools ?? []).map((call) => call.answers),
      [[]],
    );
    assert.equal(payload.run?.toolCalls[0]?.isError, true);
  } finally {
    await store.close();
  }
});

test("質問と回答は DTO に載せる前に mask する", async () => {
  const secret = "sk-live-secret-value";
  const masker = createSecretMasker([secret]);
  const questions: AskUserQuestion[] = [
    {
      question: `キー ${secret} を使いますか`,
      header: secret,
      options: [{ label: "使う", description: secret }],
    },
  ];
  const answers: AskUserAnswer[] = [{ index: 0, selected: ["使う"], text: `キーは ${secret}` }];
  const details = { questions, answers };
  const session = createScriptedSession((s) => {
    s.emit({ type: "agent_start" });
    const asked = { role: "assistant", content: [text("確認します"), askCall("call-1", questions)], timestamp: 1 };
    s.messages.push(asked);
    s.emit({ type: "message_end", message: asked });
    s.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "ask_user", args: { questions } });
    s.emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "ask_user",
      isError: false,
      result: { content: [{ type: "text", text: "ユーザーの回答:" }], details },
    });
    s.messages.push(toolResult("call-1", details));
    s.emit({ type: "agent_settled" });
  });
  const store = createStore(session, masker);
  try {
    const record = await store.create();
    const events: EventEntry[] = [];
    store.subscribe(record, undefined, (entry) => events.push(entry));
    store.postMessage(record, "聞いて");
    await waitFor(() => store.statusOf(record) !== "running", 1000, "run end");

    const payload = store.payload(record);
    const question = payload.messages.flatMap((message) => message.tools ?? [])[0]?.questions?.[0];
    assert.equal(question?.question, `キー ${REDACTED} を使いますか`);
    assert.equal(question?.header, REDACTED);
    assert.equal(question?.options?.[0]?.description, REDACTED);
    assert.equal(
      payload.messages.flatMap((message) => message.tools ?? [])[0]?.answers?.[0]?.text,
      `キーは ${REDACTED}`,
    );
    assert.deepEqual(
      events.find((entry) => entry.type === "tool_end")?.data.answers?.[0]?.text,
      `キーは ${REDACTED}`,
      "SSE のライブも同じ値",
    );
    assert.equal(
      (payload.run?.toolCalls[0]?.questions?.[0]?.question ?? "").includes(secret),
      false,
      "payload.run.toolCalls にも生の値が残らない",
    );
  } finally {
    await store.close();
  }
});

test("回答待ちの間は手動 compaction を 409 で拒む", async () => {
  const store = createStore(createPendingSession());
  try {
    const record = await store.create();
    store.postMessage(record, "聞いて");
    await waitFor(() => store.statusOf(record) === "running", 1000, "run start");
    const pending = store.askUserHost().ask(record.id, "call-1", QUESTIONS, undefined);
    await assert.rejects(
      store.compact(record),
      (error) => (error as { statusCode?: number }).statusCode === 409,
      "回答待ちは busy として扱う",
    );
    assert.equal(
      store.answerQuestion(record, "call-1", [
        { index: 0, selected: ["A"] },
        { index: 1, skipped: true },
      ]).status,
      "ok",
    );
    assert.deepEqual((await pending).length, 2);
  } finally {
    await store.close();
  }
});

test("回答エンドポイントは 200 / 409 / 404 / 400 を返す", async () => {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-ask-user-"));
  const stub = createStubPi();
  const bff = await createBffApp({
    cwd: CWD,
    sessionStoreDir: dir,
    pi: asPiBff(stub),
    workspace: stubWorkspace(),
  });
  const post = (sessionId: string, toolCallId: string, answers: unknown): Promise<Response> =>
    Promise.resolve(
      bff.app.request(`/api/sessions/${sessionId}/questions/${toolCallId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      }),
    );
  try {
    const created = (await (
      await bff.app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    ).json()) as { sessionId: string };

    const pending = bff.store.askUserHost().ask(created.sessionId, "call-1", QUESTIONS, undefined);
    const body = [
      { index: 0, selected: ["A"] },
      { index: 1, skipped: true },
    ];
    assert.equal((await post(created.sessionId, "call-1", body)).status, 200);
    assert.deepEqual(await pending, body);
    // 2 タブ目は 409、存在しない質問は 404、質問数と合わない body は 400
    assert.equal((await post(created.sessionId, "call-1", body)).status, 409);
    assert.equal((await post(created.sessionId, "call-x", body)).status, 404);
    // bootstrap が注入した実体 (ツールの execute から呼ばれる経路) でも同じように回答できる
    assert.equal(stub.askUserHosts.length, 1, "bootstrap が host を注入する");
    const viaHost = stub.askUserHosts[0].ask(created.sessionId, "call-3", QUESTIONS, undefined);
    assert.equal((await post(created.sessionId, "call-3", body)).status, 200);
    assert.deepEqual(await viaHost, body);

    const partialPending = bff.store.askUserHost().ask(created.sessionId, "call-2", QUESTIONS, undefined);
    const partial = await post(created.sessionId, "call-2", [{ index: 0, selected: ["A"] }]);
    assert.equal(partial.status, 400);
    assert.equal((await post(created.sessionId, "call-2", body)).status, 200);
    assert.deepEqual(await partialPending, body);
    assert.equal((await post("unknown-session", "call-1", body)).status, 404);
    assert.deepEqual(bff.store.statusOf(bff.store.records.get(created.sessionId)!), "idle");
  } finally {
    await bff.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("履歴の質問と回答は projectMessages を通しても同じ導出になる", () => {
  const answers: AskUserAnswer[] = [
    { index: 0, selected: ["A 案"] },
    { index: 1, skipped: true },
  ];
  const messages: PiSessionLike["messages"] = [
    { role: "user", content: "聞いて", timestamp: 1 },
    {
      role: "assistant",
      content: [text("確認します"), askCall("call-1", QUESTIONS)],
      stopReason: "stop",
      timestamp: 2,
    },
    toolResult("call-1", { questions: QUESTIONS, answers }),
  ];
  const projected = projectMessages({ messages } as unknown as PiSessionLike, noMetrics(), createSecretMasker([]), CWD);
  const call = projected.flatMap((message) => message.tools ?? [])[0];
  assert.deepEqual(call?.questions, QUESTIONS);
  assert.deepEqual(call?.answers, answers);
});

test("host の ask は record が無いセッション id を reject する", async () => {
  const store = createStore(createScriptedSession(() => {}));
  try {
    const host: AskUserHost = store.askUserHost();
    await assert.rejects(host.ask("unknown", "call-1", QUESTIONS, undefined), /Session not found/);
  } finally {
    await store.close();
  }
});
