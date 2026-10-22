// セッション診断 (GET /api/sessions/:id/diagnostics) と生ログ (GET /api/sessions/:id/raw) の検証。
// 上限・マスク・404 の契約を、stub pi の実 API と SessionRecord の直接操作で確かめる。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import {
  collectDiagnosticsEvents,
  DIAGNOSTICS_EVENT_LIMIT,
  DIAGNOSTICS_STRING_MAX,
  projectSessionDiagnostics,
} from "../src/diagnostics";
import { REDACTED, createSecretMasker } from "../src/redact";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import { SessionDiagnosticsSchema, type EventEntry } from "../src/schema";
import { sessionJsonlPath } from "../src/session-store";
import { asPiBff, createStubPi, waitFor } from "./stub-pi";

const jsonPost = (payload: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

function stubWorkspace(): SandboxWorkspaceClient {
  return {
    createDir: async (path: string) => ({ path }),
    listFiles: async (path: string) => ({ path: path || ".", entries: [], truncated: false }),
  } as unknown as SandboxWorkspaceClient;
}

async function withStoreDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-diagnostics-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function jsonBody(response: Response | Promise<Response>): Promise<any> {
  return (await response).json();
}

/** run が終わるまで待ってから診断を読む (イベント列が揃った状態で見る) */
async function postAndSettle(bff: Awaited<ReturnType<typeof createBffApp>>, id: string): Promise<void> {
  const response = await bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "診断して" }));
  assert.equal(response.status, 202);
  const record = bff.store.get(id);
  assert.ok(record, "live な record が無い");
  await waitFor(() => bff.store.statusOf(record) === "completed", 3000, "run_end");
  // run_end の保存は非同期に続くため、ファイルを読む前に確定させる
  await bff.store.flush(record);
}

test("diagnostics returns the masked server view of a live session", async () => {
  await withStoreDir(async (dir) => {
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: stubWorkspace(),
    });
    try {
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({})));
      await postAndSettle(bff, created.sessionId);

      const response = await bff.app.request(`/api/sessions/${created.sessionId}/diagnostics`);
      assert.equal(response.status, 200);
      const body = SessionDiagnosticsSchema.parse(await response.json());

      assert.equal(body.kind, "u7agent-session-diagnostics");
      assert.equal(body.version, 1);
      assert.equal(body.sessionId, created.sessionId);
      assert.equal(body.status, "completed");
      assert.equal(body.meta.agentId, "agent-general");
      assert.equal(body.meta.spaceId, "default");
      assert.equal(body.meta.sendsDirty, false);
      assert.equal(body.queue.depth, 0);
      assert.equal(body.run?.totalRetryCount, 0);
      assert.deepEqual(body.questions, []);
      assert.equal(body.raw.available, true);
      assert.ok((body.raw.bytes ?? 0) > 0, "生ログのバイト数が載っていない");

      const types = body.events.items.map((item) => item.type);
      assert.ok(types.includes("run_start"), "run_start が無い");
      assert.ok(types.includes("run_end"), "run_end が無い");
      assert.equal(body.events.available, body.events.items.length, "上限内なのに available と件数がずれている");
      assert.equal(body.events.dropped, 0);
      assert.equal(body.events.truncated, 0);
      // 直近の run_end が最後に並ぶ (古い→新しい順)
      assert.equal(body.events.items.at(-1)?.type, "run_end");
    } finally {
      await bff.close();
    }
  });
});

test("diagnostics drops the oldest events over the count limit and truncates long data", async () => {
  await withStoreDir(async (dir) => {
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: stubWorkspace(),
    });
    try {
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({})));
      const record = bff.store.get(created.sessionId);
      assert.ok(record, "live な record が無い");
      const overflow = 12;
      for (let index = 0; index < DIAGNOSTICS_EVENT_LIMIT + overflow; index += 1) {
        bff.store.emit(record, "status", { state: "thinking", text: `tick ${index}` });
      }
      bff.store.emit(record, "status", { state: "thinking", text: "x".repeat(DIAGNOSTICS_STRING_MAX * 2) });

      const body = SessionDiagnosticsSchema.parse(
        await jsonBody(bff.app.request(`/api/sessions/${created.sessionId}/diagnostics`)),
      );
      assert.equal(body.events.limit, DIAGNOSTICS_EVENT_LIMIT);
      assert.equal(body.events.available, DIAGNOSTICS_EVENT_LIMIT + overflow + 1);
      assert.equal(body.events.items.length, DIAGNOSTICS_EVENT_LIMIT);
      assert.equal(body.events.dropped, overflow + 1);
      const last = body.events.items.at(-1);
      assert.ok(last, "最後のイベントが無い");
      assert.equal(last.truncated, true, "上限を超える data が切り詰められていない");
      assert.equal(body.events.truncated, 1);
      const text = (last.data as { text?: unknown }).text;
      assert.ok(typeof text === "string" && text.length <= DIAGNOSTICS_STRING_MAX + 1);
      assert.ok(last.bytes > DIAGNOSTICS_STRING_MAX * 2, "切り詰め前のバイト数が残っていない");
    } finally {
      await bff.close();
    }
  });
});

test("raw log is served as a download and matches session.jsonl", async () => {
  await withStoreDir(async (dir) => {
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: stubWorkspace(),
    });
    try {
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({})));
      await postAndSettle(bff, created.sessionId);

      const response = await bff.app.request(`/api/sessions/${created.sessionId}/raw`);
      assert.equal(response.status, 200);
      const disposition = response.headers.get("content-disposition") ?? "";
      assert.match(disposition, /^attachment; filename="u7agent-raw-[0-9a-f]{8}-\d{8}-\d{4}\.jsonl"$/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.text();
      assert.equal(body, await readFile(sessionJsonlPath(created.sessionId, dir), "utf8"));
      assert.match(body, /診断して/, "生ログに本文が入っていない");
    } finally {
      await bff.close();
    }
  });
});

test("diagnostics never carries message, question or answer bodies", async () => {
  await withStoreDir(async (dir) => {
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: stubWorkspace(),
    });
    try {
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({})));
      const marker = "本文はここに残ってはいけない";
      const response = await bff.app.request(`/api/sessions/${created.sessionId}/messages`, jsonPost({ text: marker }));
      assert.equal(response.status, 202);
      const record = bff.store.get(created.sessionId);
      assert.ok(record, "live な record が無い");
      const argsLiteral = '{"questions":[]}';
      // 質問 / 回答 / 進捗 / 圧縮の要約も、本文ではなく件数と文字数だけが載ることを見る
      bff.store.emit(record, "tool_start", {
        id: "t-1",
        name: "ask_user",
        args: argsLiteral,
        questions: [{ question: marker, options: [{ label: marker }] }],
      });
      bff.store.emit(record, "tool_end", {
        id: "t-1",
        name: "ask_user",
        isError: false,
        output: marker,
        answers: [
          { index: 0, text: marker },
          { index: 1, skipped: true },
        ],
      });
      bff.store.emit(record, "tool_progress", { id: "t-1", text: marker });
      await waitFor(() => bff.store.statusOf(record) === "completed", 3000, "run_end");

      const body = SessionDiagnosticsSchema.parse(
        await jsonBody(bff.app.request(`/api/sessions/${created.sessionId}/diagnostics`)),
      );
      const json = JSON.stringify(body);
      assert.equal(json.includes(marker), false, "本文が診断 JSON に残っている");

      const items = new Map(body.events.items.map((item) => [item.type, item.data as Record<string, unknown>]));
      const runStart = items.get("run_start") ?? {};
      assert.equal(typeof runStart.runId, "string");
      assert.equal(typeof runStart.startedAt, "number");
      assert.equal(runStart.promptChars, marker.length, "プロンプトの本文ではなく文字数になっていない");
      assert.equal(Array.isArray(items.get("tool_start")?.questions), false, "質問の配列がそのまま載っている");
      assert.deepEqual(items.get("tool_start"), {
        id: "t-1",
        name: "ask_user",
        argsChars: argsLiteral.length,
        questions: 1,
      });
      assert.deepEqual(items.get("tool_end"), {
        id: "t-1",
        name: "ask_user",
        isError: false,
        outputChars: marker.length,
        answers: 2,
        skipped: 1,
      });
      assert.deepEqual(items.get("tool_progress"), { id: "t-1", chars: marker.length });
      // resync は payload 全体ではなく、件数と相関キーだけになる
      const resync = body.events.items.find((item) => item.type === "resync")?.data as Record<string, unknown>;
      if (resync) {
        assert.equal("messages" in resync, false, "resync に messages が載っている");
        assert.equal(typeof resync.messageCount, "number");
      }
    } finally {
      await bff.close();
    }
  });
});

test("diagnostics and raw log serve an unloaded session without restoring it", async () => {
  await withStoreDir(async (dir) => {
    const first = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: stubWorkspace(),
    });
    const created = await jsonBody(first.app.request("/api/sessions", jsonPost({})));
    await postAndSettle(first, created.sessionId);
    await first.close();

    // 再起動相当 (descriptor だけが在り、live な record は無い)。壊れた JSONL を復元しようとすると
    // 409 になる場面でも診断は取りたいので、SDK を開かないことをここで固定する
    const second = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: stubWorkspace(),
    });
    try {
      assert.equal(second.store.get(created.sessionId), undefined, "起動直後に live な record がある");
      const diagnostics = SessionDiagnosticsSchema.parse(
        await jsonBody(second.app.request(`/api/sessions/${created.sessionId}/diagnostics`)),
      );
      assert.equal(diagnostics.sessionId, created.sessionId);
      assert.equal(diagnostics.status, "idle");
      assert.equal(diagnostics.eventGeneration, "");
      assert.equal(diagnostics.events.available, 0);
      assert.equal(diagnostics.raw.available, true);
      assert.ok(diagnostics.meta.messageCount >= 1, "保存済みのメッセージ数が載っていない");
      assert.equal(second.store.get(created.sessionId), undefined, "診断が SDK を開いている");

      const raw = await second.app.request(`/api/sessions/${created.sessionId}/raw`);
      assert.equal(raw.status, 200);
      assert.match(await raw.text(), /診断して/);
      assert.equal(second.store.get(created.sessionId), undefined, "生ログが SDK を開いている");
    } finally {
      await second.close();
    }
  });
});

test("diagnostics and raw log reject unknown sessions and sessions without a record", async () => {
  const bff = await createBffApp({
    cwd: "/tmp/project",
    sessionStoreDir: null,
    pi: asPiBff(createStubPi()),
    workspace: stubWorkspace(),
  });
  try {
    const diagnostics = await bff.app.request("/api/sessions/ffffffffff/diagnostics");
    assert.equal(diagnostics.status, 404);
    const raw = await bff.app.request("/api/sessions/ffffffffff/raw");
    assert.equal(raw.status, 404);

    // 永続化なしの会話は診断だけ取れる (raw は無いことを応答で示す)
    const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({})));
    const body = SessionDiagnosticsSchema.parse(
      await jsonBody(bff.app.request(`/api/sessions/${created.sessionId}/diagnostics`)),
    );
    assert.deepEqual(body.raw, { available: false });
    const missing = await bff.app.request(`/api/sessions/${created.sessionId}/raw`);
    assert.equal(missing.status, 404);
    assert.equal((await jsonBody(missing)).error, "この会話の記録は保存されていないため、生ログは取れません。");
    const summary = (await jsonBody(bff.app.request("/api/sessions"))).sessions.find(
      (item: { sessionId: string }) => item.sessionId === created.sessionId,
    );
    assert.equal(summary.hasRawLog, false);
  } finally {
    await bff.close();
  }
});

test("diagnostics masks captured strings and keeps the stored event data", () => {
  const secret = "sk-live-diagnostics-secret";
  const diagnostics = projectSessionDiagnostics({
    masker: createSecretMasker([secret]),
    input: {
      sessionId: "s-1",
      generation: "gen-1",
      seq: 1,
      events: [{ seq: 1, type: "status", data: { state: "thinking", text: `token=${secret}` }, at: 1 }],
      status: "running",
      queueSendIds: [],
      run: { id: "r-1", status: "running", startedAt: 1, totalRetryCount: 0, error: `失敗 ${secret}` },
      questions: [],
      meta: {
        spaceId: "default",
        agentId: "agent-general",
        agentName: `エージェント ${secret}`,
        workdir: "",
        createdAt: 1,
        lastUsedAt: 1,
        messageCount: 0,
        notify: false,
        pinned: false,
        persistError: `保存失敗 ${secret}`,
        sendsDirty: true,
      },
      raw: { available: false },
    },
  });
  assert.equal(diagnostics.meta.agentName, `エージェント ${REDACTED}`);
  assert.equal(diagnostics.meta.persistError, `保存失敗 ${REDACTED}`);
  assert.equal(diagnostics.run?.error, `失敗 ${REDACTED}`);
  assert.equal(diagnostics.meta.sendsDirty, true);
  assert.equal(diagnostics.raw.available, false);
  // イベントは emit 時点でマスク済みの値が正で、投影はそのまま載せる
  const lastEvent = diagnostics.events.items.at(-1);
  assert.ok(lastEvent, "イベントが 1 件も無い");
  assert.equal((lastEvent.data as { text: string }).text, `token=${secret}`);
});

test("collectDiagnosticsEvents keeps the byte budget and counts what it drops", () => {
  const entry = (seq: number, text: string): EventEntry => ({
    seq,
    type: "status",
    data: { state: "thinking", text },
    at: seq,
  });
  const small = collectDiagnosticsEvents([entry(1, "a"), entry(2, "b")]);
  assert.deepEqual(
    small.items.map((item) => [item.seq, item.type]),
    [
      [1, "status"],
      [2, "status"],
    ],
  );
  assert.equal(small.available, 2);
  assert.equal(small.dropped, 0);

  // 1 件が上限バイトを超えても空にはせず、古い方から落とす
  const big = collectDiagnosticsEvents(
    Array.from({ length: 20 }, (_, index) => entry(index + 1, "y".repeat(8 * 1024))),
  );
  assert.ok(big.items.length > 0, "全部落として空のダンプにしている");
  assert.equal(big.dropped, 20 - big.items.length);
  assert.ok(big.items.every((item) => item.truncated === true));
});
