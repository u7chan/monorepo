// SDK の getContextUsage() は compaction entry の usage を無条件に読むため、usage を持たない
// 旧 / 手作り JSONL では例外になる。context は補助情報なので、BFF は失敗をキー省略へ縮退させて
// セッションを開けるようにする (500 にしない)。
import assert from "node:assert/strict";
import test from "node:test";
import { createAgentCatalog } from "../src/agents";
import { createBffApp } from "../src/app";
import { SessionStore } from "../src/sessions";
import { asPiBff, createStubPi, type StubSession } from "./stub-pi";

/** 実 SDK が compaction entry の usage 欠落で投げる例外を再現する */
function breakContextUsage(session: StubSession): void {
  (session as unknown as { getContextUsage: () => unknown }).getContextUsage = () => {
    throw new TypeError("Cannot read properties of undefined (reading 'totalTokens')");
  };
}

function appendTurn(session: StubSession): void {
  session.appendMessage({ role: "user", content: "u1", timestamp: 1 });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "a1" }],
    stopReason: "stop",
    timestamp: 2,
  });
}

test("getContextUsage が例外でも payload は context を省略して返る", async () => {
  const pi = createStubPi();
  const store = new SessionStore({ pi, catalog: createAgentCatalog() });
  const record = await store.create();
  const session = pi.sessions[0] as StubSession;
  appendTurn(session);
  breakContextUsage(session);

  const payload = store.payload(record);
  assert.equal("context" in payload, false, "context はキーごと省略する");
  assert.equal(payload.messages.length, 2, "履歴の投影は続けられる");
  await store.close();
});

test("GET /api/sessions/:id は getContextUsage の例外で 500 にならない", async () => {
  const pi = createStubPi();
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(pi) });
  const { app } = bff;
  try {
    const created = (await (
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    ).json()) as { sessionId: string };
    const session = pi.sessions[0] as StubSession;
    appendTurn(session);
    breakContextUsage(session);

    const response = await app.request(`/api/sessions/${created.sessionId}`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { context?: unknown; messages: unknown[] };
    assert.equal("context" in payload, false);
    assert.equal(payload.messages.length, 2);
  } finally {
    await bff.close();
  }
});
