// スキル読み込み (read + basename SKILL.md) の導出。履歴 (projectMessages) とライブ (run-events) が
// 同じ判定を共有し、繰り上げ・マスク・abort の扱いが経路でずれないことを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { createAgentCatalog } from "../src/agents";
import { catalogSkillPath } from "../src/catalog-skills";
import { createSecretMasker, REDACTED } from "../src/redact";
import { classifySkillRead, displayableMessages, projectMessages } from "../src/session-projection";
import type { EventEntry, MessageMetrics, SkillLoad } from "../src/schema";
import {
  SessionStore,
  type PiRuntimeLike,
  type PiSessionEvent,
  type PiSessionEventListener,
  type PiSessionLike,
} from "../src/sessions";
import { createStubPi, waitFor, type StubSession } from "./stub-pi";

const CWD = "/tmp/project";
const masker = createSecretMasker([]);
const noMetrics = () => new WeakMap<object, MessageMetrics>();

type TestMessage = PiSessionLike["messages"][number];

function user(text: string): TestMessage {
  return { role: "user", content: text, timestamp: 1 };
}

function assistant(content: unknown, options: { stopReason?: string } = {}): TestMessage {
  return { role: "assistant", content, stopReason: options.stopReason ?? "stop", timestamp: 2 };
}

function toolResult(id: string, isError = false): TestMessage {
  return {
    role: "toolResult",
    content: [{ type: "text", text: "body" }],
    toolCallId: id,
    isError,
    timestamp: 3,
  };
}

function readCall(id: string, path: string, extra: Record<string, unknown> = {}): unknown {
  return { type: "toolCall", id, name: "read", arguments: { path, ...extra } };
}

function text(value: string): unknown {
  return { type: "text", text: value };
}

/** メッセージ配列だけを持つ最小セッション (projectMessages は messages しか読まない) */
function messagesOf(messages: TestMessage[]): PiSessionLike {
  return { messages } as unknown as PiSessionLike;
}

function project(messages: TestMessage[], secretMasker = masker): ReturnType<typeof projectMessages> {
  return projectMessages(messagesOf(messages), noMetrics(), secretMasker, CWD);
}

function skillLoadsOf(messages: ReturnType<typeof projectMessages>): SkillLoad[] {
  return messages.flatMap((message) => message.skillLoads ?? []);
}

test("classifySkillRead は解決後の basename だけで判定する", () => {
  assert.deepEqual(classifySkillRead({ path: "/work/.agents/skills/gh/SKILL.md" }, { cwd: CWD, toolName: "read" }), {
    path: "/work/.agents/skills/gh/SKILL.md",
    name: "gh",
  });
  assert.deepEqual(classifySkillRead({ path: ".agents/skills/gh/SKILL.md" }, { cwd: CWD, toolName: "read" }), {
    path: `${CWD}/.agents/skills/gh/SKILL.md`,
    name: "gh",
  });
  assert.deepEqual(classifySkillRead({ path: "./SKILL.md" }, { cwd: CWD, toolName: "read" }), {
    path: `${CWD}/SKILL.md`,
    name: "project",
  });
  assert.deepEqual(classifySkillRead({ path: "../gh/SKILL.md" }, { cwd: CWD, toolName: "read" }), {
    path: "/tmp/gh/SKILL.md",
    name: "gh",
  });
  // ルート直下は親ディレクトリ名が空になるため、pi と同じくファイル名へ落とす
  assert.deepEqual(classifySkillRead({ path: "/SKILL.md" }, { cwd: CWD, toolName: "read" }), {
    path: "/SKILL.md",
    name: "SKILL.md",
  });
  // pi の renderer と同じ file_path エイリアスを受ける
  assert.deepEqual(classifySkillRead({ file_path: "gh/SKILL.md" }, { cwd: CWD, toolName: "read" }), {
    path: `${CWD}/gh/SKILL.md`,
    name: "gh",
  });
  // offset / limit は数値のときだけ行範囲として持つ
  assert.deepEqual(classifySkillRead({ path: "gh/SKILL.md", offset: 5, limit: 3 }, { cwd: CWD, toolName: "read" }), {
    path: `${CWD}/gh/SKILL.md`,
    name: "gh",
    offset: 5,
    limit: 3,
  });
  assert.deepEqual(classifySkillRead({ path: "gh/SKILL.md", offset: "5" }, { cwd: CWD, toolName: "read" }), {
    path: `${CWD}/gh/SKILL.md`,
    name: "gh",
  });
});

test("classifySkillRead は SKILL.md 以外と非対応のパス形を分類しない", () => {
  for (const path of [
    "gh/SKILL.md.bak",
    "gh/skill.md",
    "gh/SKILL.md/notes.md",
    "gh/SKILL.mdx",
    // ~ 展開・@ 接頭辞・file:// は pi の resolveToCwd 全互換を狙わないため非対応
    "~/gh/SKILL.md",
    "@/gh/SKILL.md",
    "file:///work/gh/SKILL.md",
  ]) {
    assert.equal(classifySkillRead({ path }, { cwd: CWD, toolName: "read" }), undefined, path);
  }
  assert.equal(classifySkillRead({ path: "" }, { cwd: CWD, toolName: "read" }), undefined);
  assert.equal(classifySkillRead({}, { cwd: CWD, toolName: "read" }), undefined);
  assert.equal(classifySkillRead(undefined, { cwd: CWD, toolName: "read" }), undefined);
});

test("classifySkillRead は read 以外のツール名を分類しない", () => {
  // skill-creator の手順は write で <置き場所>/<name>/SKILL.md を作るため、read 以外の除外は必須
  for (const toolName of ["write", "edit", "grep", "bash", ""]) {
    assert.equal(
      classifySkillRead({ path: ".agents/skills/new-skill/SKILL.md" }, { cwd: CWD, toolName }),
      undefined,
      toolName || "(empty)",
    );
  }
});

test("projectMessages は本文を持たない read だけのターンを次の表示メッセージへ繰り上げる", () => {
  const messages = [
    user("スキルを読んで"),
    assistant([readCall("call-1", ".agents/skills/gh/SKILL.md")]),
    toolResult("call-1"),
    assistant([text("読みました")]),
  ];
  const projected = project(messages);

  assert.deepEqual(
    projected.map((message) => [message.role, message.text]),
    [
      ["user", "スキルを読んで"],
      ["assistant", "読みました"],
    ],
    "表示集合は変わらない (本文を持たないメッセージはバブルにしない)",
  );
  assert.equal(projected.length, displayableMessages(messagesOf(messages), masker).length);
  assert.deepEqual(projected[1].skillLoads, [{ id: "call-1", name: "gh", path: `${CWD}/.agents/skills/gh/SKILL.md` }]);
  assert.equal(projected[0].skillLoads, undefined, "user バブルには載せない");
});

test("projectMessages は繰り上げをターン内の次の user メッセージで止める", () => {
  const messages = [
    user("1 つ目"),
    assistant([readCall("call-1", "gh/SKILL.md")]),
    toolResult("call-1"),
    user("2 つ目"),
    assistant([text("次のターンです")]),
  ];
  const projected = project(messages);

  assert.deepEqual(
    projected.map((message) => message.text),
    ["1 つ目", "2 つ目", "次のターンです"],
  );
  assert.equal(projected[2].skillLoads, undefined, "user メッセージを越えて運ばない");
});

test("projectMessages はターン内に表示メッセージが無い read を落とす", () => {
  // read の直後に abort して本文が無いケース
  const messages = [
    user("読んで"),
    assistant([readCall("call-1", "gh/SKILL.md")], { stopReason: "aborted" }),
    toolResult("call-1"),
  ];
  const projected = project(messages);

  assert.equal(projected.length, 1);
  assert.equal(skillLoadsOf(projected).length, 0);
});

test("projectMessages はメッセージ順 → part 順で並べ、繰り上げ分を先に置く", () => {
  const messages = [
    user("まとめて読んで"),
    assistant([readCall("call-1", "first/SKILL.md")]),
    toolResult("call-1"),
    assistant([readCall("call-2", "second/SKILL.md"), readCall("call-3", "third/SKILL.md"), text("読みました")]),
    toolResult("call-2"),
    toolResult("call-3"),
  ];
  const projected = project(messages);

  assert.deepEqual(
    projected.at(-1)?.skillLoads?.map((load) => load.id),
    ["call-1", "call-2", "call-3"],
  );
});

test("projectMessages は toolResult の isError を載せ、aborted の未実行 read は出さない", () => {
  const messages = [
    user("読んで"),
    assistant(
      [
        readCall("call-error", "broken/SKILL.md"),
        readCall("call-unrun", "unrun/SKILL.md"),
        readCall("call-ok", "ok/SKILL.md"),
      ],
      { stopReason: "aborted" },
    ),
    // abort でも実行済みの read は result を持つ
    toolResult("call-error", true),
    toolResult("call-ok"),
    assistant([text("途中まで")]),
  ];
  const projected = project(messages);

  assert.deepEqual(projected.at(-1)?.skillLoads, [
    { id: "call-error", name: "broken", path: `${CWD}/broken/SKILL.md`, isError: true },
    { id: "call-ok", name: "ok", path: `${CWD}/ok/SKILL.md` },
  ]);
});

test("projectMessages は result の無い read を原則ロード扱いにする (abort だけ除く)", () => {
  // crash / restart・compaction 境界の欠落は実行済みとして扱う
  const crashed = project([user("読んで"), assistant([readCall("call-1", "gh/SKILL.md")]), assistant([text("続き")])]);
  assert.deepEqual(crashed.at(-1)?.skillLoads, [{ id: "call-1", name: "gh", path: `${CWD}/gh/SKILL.md` }]);

  // 組み込みスキルの仮想パスも同じ規則で成立する
  const builtin = project([
    user("読んで"),
    assistant([readCall("call-1", ".u7agent/builtin-skills/skill-creator/SKILL.md")]),
    assistant([text("続き")]),
  ]);
  assert.deepEqual(builtin.at(-1)?.skillLoads, [
    { id: "call-1", name: "skill-creator", path: `${CWD}/.u7agent/builtin-skills/skill-creator/SKILL.md` },
  ]);
});

test("解決 → 分類 → mask の順で、秘密値に / が混ざっても判定が壊れない", () => {
  const secret = "leak-dir/SKILL.md";
  const secretMasker = createSecretMasker([secret]);
  const projected = project(
    [
      user("読んで"),
      assistant([readCall("call-1", "/tmp/leak-dir/SKILL.md")]),
      toolResult("call-1"),
      assistant([text("読みました")]),
    ],
    secretMasker,
  );

  // 生パスで分類してからマスクするため、行は出たまま path だけが置換される
  assert.deepEqual(projected.at(-1)?.skillLoads, [{ id: "call-1", name: "leak-dir", path: `/tmp/${REDACTED}` }]);
});

/** ライブのイベントと履歴を同じターンで流せる最小セッション */
interface ScriptedSession extends PiSessionLike {
  emit(event: PiSessionEvent): void;
}

function createScriptedSession(run: (session: ScriptedSession) => void): ScriptedSession {
  const listeners = new Set<PiSessionEventListener>();
  const session = {
    sessionId: "pi-skill",
    model: { provider: "stub", id: "stub-model" },
    thinkingLevel: "low",
    messages: [] as PiSessionLike["messages"],
    isStreaming: false,
    abortRequested: false,
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
    async abort() {
      session.abortRequested = true;
    },
    dispose() {
      session.disposed = true;
    },
    async prompt() {
      session.isStreaming = true;
      try {
        run(session);
      } finally {
        session.isStreaming = false;
      }
    },
  };
  return session as unknown as ScriptedSession;
}

test("ライブの ToolCall.skill は履歴の skillLoads と同じ値になる", async () => {
  const args = { path: ".agents/skills/gh/SKILL.md", offset: 5, limit: 3 };
  const session = createScriptedSession((s) => {
    s.emit({ type: "agent_start" });
    const toolOnly = {
      role: "assistant",
      content: [readCall("call-1", ".agents/skills/gh/SKILL.md", { offset: 5, limit: 3 })],
      stopReason: "stop",
      timestamp: Date.now(),
    };
    s.messages.push(toolOnly);
    s.emit({ type: "message_end", message: toolOnly });
    s.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args });
    s.emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      isError: false,
      result: { content: [{ type: "text", text: "body" }] },
    });
    s.messages.push(toolResult("call-1"));
    const answer = {
      role: "assistant",
      content: [text("読みました")],
      stopReason: "stop",
      timestamp: Date.now(),
    };
    s.messages.push(answer);
    s.emit({ type: "message_end", message: answer });
    s.emit({ type: "agent_settled" });
  });
  const store = new SessionStore({
    pi: { createSession: async () => ({ session }) } as unknown as PiRuntimeLike,
    catalog: createAgentCatalog(),
    masker,
    rootCwd: CWD,
  });
  const record = await store.create();
  const events: EventEntry[] = [];
  store.subscribe(record, undefined, (entry) => events.push(entry));

  store.postMessage(record, "スキルを読んで");
  await waitFor(() => store.statusOf(record) === "completed", 3000, "run completion");

  const expected: SkillLoad = {
    id: "call-1",
    name: "gh",
    path: `${CWD}/.agents/skills/gh/SKILL.md`,
    offset: 5,
    limit: 3,
  };
  const payload = store.payload(record);
  assert.deepEqual(
    payload.run?.toolCalls.map((call) => call.skill),
    [expected],
    "ライブの ToolCall.skill",
  );
  assert.deepEqual(payload.messages.at(-1)?.skillLoads, [expected], "履歴の skillLoads");
  const toolStart = events.find((entry) => entry.type === "tool_start");
  assert.deepEqual(toolStart?.data.skill, expected, "SSE の tool_start も同じ値");
  await store.close();
});

test("カタログスキルの仮想パスを read するとライブ / 履歴の [skill] 行に出る", async () => {
  // カタログは索引だけを system prompt へ渡し、本文は read で読む (仮想パスは BFF が横取りする)
  const path = catalogSkillPath(CWD, "writer");
  const args = { path };
  const session = createScriptedSession((s) => {
    s.emit({ type: "agent_start" });
    const toolOnly = {
      role: "assistant",
      content: [readCall("call-1", path)],
      stopReason: "stop",
      timestamp: Date.now(),
    };
    s.messages.push(toolOnly);
    s.emit({ type: "message_end", message: toolOnly });
    s.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args });
    s.emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      isError: false,
      result: { content: [{ type: "text", text: "body" }] },
    });
    s.messages.push(toolResult("call-1"));
    const answer = {
      role: "assistant",
      content: [text("読みました")],
      stopReason: "stop",
      timestamp: Date.now(),
    };
    s.messages.push(answer);
    s.emit({ type: "message_end", message: answer });
    s.emit({ type: "agent_settled" });
  });
  const store = new SessionStore({
    pi: { createSession: async () => ({ session }) } as unknown as PiRuntimeLike,
    catalog: createAgentCatalog(),
    masker,
    rootCwd: CWD,
  });
  const record = await store.create();
  const events: EventEntry[] = [];
  store.subscribe(record, undefined, (entry) => events.push(entry));

  store.postMessage(record, "スキルを読んで");
  await waitFor(() => store.statusOf(record) === "completed", 3000, "run completion");

  const expected: SkillLoad = { id: "call-1", name: "writer", path };
  const payload = store.payload(record);
  assert.deepEqual(
    payload.run?.toolCalls.map((call) => call.skill),
    [expected],
    "ライブの ToolCall.skill",
  );
  assert.deepEqual(payload.messages.at(-1)?.skillLoads, [expected], "履歴の skillLoads");
  const toolStart = events.find((entry) => entry.type === "tool_start");
  assert.deepEqual(toolStart?.data.skill, expected, "SSE の tool_start も同じ値");
  await store.close();
});

test("read 以外が SKILL.md を指してもライブ / 履歴のどちらにもスキル読み込みを出さない", async () => {
  // skill-creator の手順 (write で SKILL.md を作る) が通常操作なので、ライブだけに出ると復元後の表示と食い違う
  const args = { path: ".agents/skills/new-skill/SKILL.md", content: "新しいスキル" };
  const session = createScriptedSession((s) => {
    s.emit({ type: "agent_start" });
    const assistant = {
      role: "assistant",
      content: [text("作りました"), { type: "toolCall", id: "call-write", name: "write", arguments: args }],
      stopReason: "stop",
      timestamp: Date.now(),
    };
    s.messages.push(assistant);
    s.emit({ type: "message_end", message: assistant });
    s.emit({ type: "tool_execution_start", toolCallId: "call-write", toolName: "write", args });
    s.emit({
      type: "tool_execution_end",
      toolCallId: "call-write",
      toolName: "write",
      isError: false,
      result: { content: [{ type: "text", text: "書き込みました" }] },
    });
    s.emit({ type: "agent_settled" });
  });
  const store = new SessionStore({
    pi: { createSession: async () => ({ session }) } as unknown as PiRuntimeLike,
    catalog: createAgentCatalog(),
    masker,
    rootCwd: CWD,
  });
  const record = await store.create();
  const events: EventEntry[] = [];
  store.subscribe(record, undefined, (entry) => events.push(entry));

  store.postMessage(record, "スキルを作って");
  await waitFor(() => store.statusOf(record) === "completed", 3000, "run completion");

  const payload = store.payload(record);
  assert.equal(payload.run?.toolCalls[0]?.skill, undefined, "ライブの ToolCall.skill");
  assert.equal(payload.messages.at(-1)?.skillLoads, undefined, "履歴の skillLoads");
  const toolStart = events.find((entry) => entry.type === "tool_start");
  assert.equal(toolStart?.data.skill, undefined, "SSE の tool_start");
  await store.close();
});

test("store の payload / summary / run_end は read だけのターンで表示メッセージ数を変えない", async () => {
  const store = new SessionStore({ pi: createStubPi(), catalog: createAgentCatalog(), masker, rootCwd: CWD });
  const record = await store.create();
  const session = record.session as unknown as StubSession;
  session.appendMessage({ role: "user", content: "最初の質問", timestamp: 1 });
  session.appendMessage({ role: "assistant", content: [text("最初の答え")], timestamp: 2 });
  // 1 件目の表示メッセージまでを要約し、2 件目を残す
  await session.compact({ summarizeCount: 1 });
  session.appendMessage({ role: "user", content: "スキルを読んで", timestamp: 3 });
  session.appendMessage({
    role: "assistant",
    content: [readCall("call-1", ".agents/skills/gh/SKILL.md")],
    timestamp: 4,
  });
  session.appendMessage({
    role: "toolResult",
    content: [{ type: "text", text: "body" }],
    toolCallId: "call-1",
    isError: false,
    timestamp: 5,
  });
  session.appendMessage({ role: "assistant", content: [text("読みました")], timestamp: 6 });

  const events: EventEntry[] = [];
  store.subscribe(record, undefined, (entry) => events.push(entry));
  store.postMessage(record, "続き");
  await waitFor(() => record.run?.status === "completed", 3000, "run completion");

  const payload = store.payload(record);
  const live = store.summary(record).messageCount;
  assert.deepEqual(
    payload.messages.map((message) => [message.role, message.text]),
    [
      ["assistant", "最初の答え"],
      ["user", "スキルを読んで"],
      ["assistant", "読みました"],
      ["user", "続き"],
      ["assistant", "スタブの返答です"],
    ],
    "read だけのターンはバブルにしない",
  );
  assert.equal(payload.messages.length, live, "本文と件数が同じ集合");
  const runEnd = events.find((entry) => entry.type === "run_end");
  assert.ok(runEnd, "run_end が記録される");
  assert.equal((runEnd.data as { messageCount?: number }).messageCount, live, "run_end も同じ定義");
  assert.deepEqual(payload.messages[2].skillLoads, [
    { id: "call-1", name: "gh", path: `${CWD}/.agents/skills/gh/SKILL.md` },
  ]);
  assert.equal(payload.compactions[0].beforeMessageIndex, 1, "compaction の区切り位置も動かない");
  await store.close();
});
