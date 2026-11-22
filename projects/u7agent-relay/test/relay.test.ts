// 中継の投稿・返信の契約。Bearer 認証、キーごとの可視範囲、上流の状態の丸め方を固定する。
import { describe, expect, test } from "bun:test";
import type { FetchLike } from "../src/server/upstream";
import {
  bearer,
  createHarness,
  jsonResponse,
  RUN_ID,
  SESSION_ID,
  SPACE_ID,
  seedConnection,
  type Harness,
} from "./harness";

type Call = { url: string; method: string; body: string | null };

function createUpstream() {
  const calls: Call[] = [];
  let session: Record<string, unknown> = {
    sessionId: SESSION_ID,
    spaceId: SPACE_ID,
    status: "idle",
    queueDepth: 0,
    messages: [],
  };
  let accepted: unknown = { queued: false, runId: RUN_ID };
  let failing = false;

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";

    calls.push({ url: String(input), method, body: typeof init?.body === "string" ? init.body : null });

    if (failing) {
      throw new Error("upstream down");
    }

    return method === "GET" ? jsonResponse(session) : jsonResponse(accepted, 202);
  };

  return {
    calls,
    fetchImpl,
    setSession(next: Record<string, unknown>) {
      session = next;
    },
    setAccepted(next: unknown) {
      accepted = next;
    },
    fail(on: boolean) {
      failing = on;
    },
  };
}

async function setup(fetchImpl: FetchLike): Promise<Harness> {
  return createHarness({ fetchImpl });
}

describe("中継 API", () => {
  test("healthz は認証なしで固定の応答を返し、上流へは行かない", async () => {
    const upstream = createUpstream();
    const harness = await setup(upstream.fetchImpl);

    try {
      const response = await harness.app.request("/healthz");

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("u7agent-relay-ok\n");
      expect(upstream.calls).toHaveLength(0);
    } finally {
      harness.cleanup();
    }
  });

  test("Bearer が無い・形式が違う・未登録なら 401", async () => {
    const upstream = createUpstream();
    const harness = await setup(upstream.fetchImpl);

    try {
      for (const headers of [undefined, { Authorization: "Bearer nope" }, bearer(`ur_${"a".repeat(43)}`)]) {
        const response = await harness.app.request("/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ text: "hello" }),
        });

        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toContain("Bearer");
      }

      expect(upstream.calls).toHaveLength(0);
    } finally {
      harness.cleanup();
    }
  });

  test("投稿は接続先の会話へだけ送り、返信はその実行の最後の本文を返す", async () => {
    const upstream = createUpstream();
    const harness = await setup(upstream.fetchImpl);

    try {
      const { token } = seedConnection(harness);

      const posted = await harness.app.request("/v1/messages", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ text: "  調べて  " }),
      });

      expect(posted.status).toBe(202);
      expect(await posted.json()).toEqual({ runId: RUN_ID });
      expect(upstream.calls[0]?.url).toBe(`https://agent.example.com/api/sessions/${SESSION_ID}?spaceId=${SPACE_ID}`);
      expect(upstream.calls[1]?.url).toBe(
        `https://agent.example.com/api/sessions/${SESSION_ID}/messages?spaceId=${SPACE_ID}`,
      );
      expect(upstream.calls[1]?.body).toBe(JSON.stringify({ text: "調べて" }));

      upstream.setSession({
        sessionId: SESSION_ID,
        spaceId: SPACE_ID,
        status: "completed",
        queueDepth: 0,
        run: { id: RUN_ID, status: "completed" },
        messages: [
          { role: "user", text: "調べて" },
          { role: "assistant", text: "古い応答", assistantId: "aaaaaaaaaaaaaaaa:0" },
          { role: "assistant", text: "最終応答", assistantId: `${RUN_ID}:0` },
        ],
      });

      const reply = await harness.app.request(`/v1/replies/${RUN_ID}`, { headers: bearer(token) });

      expect(reply.status).toBe(200);
      expect(await reply.json()).toEqual({ status: "completed", text: "最終応答" });
    } finally {
      harness.cleanup();
    }
  });

  test("回答待ちの実行は sessionUrl を返す", async () => {
    const upstream = createUpstream();
    const harness = await setup(upstream.fetchImpl);

    try {
      const { token } = seedConnection(harness);

      await harness.app.request("/v1/messages", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ text: "確認して" }),
      });

      upstream.setSession({
        sessionId: SESSION_ID,
        spaceId: SPACE_ID,
        status: "running",
        queueDepth: 0,
        run: {
          id: RUN_ID,
          status: "running",
          toolCalls: [{ done: false, questions: [{ question: "どちらにしますか" }] }],
        },
      });

      const reply = await harness.app.request(`/v1/replies/${RUN_ID}`, { headers: bearer(token) });

      expect(await reply.json()).toEqual({
        status: "awaiting_answer",
        sessionUrl: `https://agent.example.com/s/${SESSION_ID}?space=${SPACE_ID}`,
      });
    } finally {
      harness.cleanup();
    }
  });

  test("上流がキューに積んだ投稿は runId を返さず、追跡もできない", async () => {
    const upstream = createUpstream();
    const harness = await setup(upstream.fetchImpl);

    try {
      const { token } = seedConnection(harness);

      upstream.setAccepted({ queued: true });

      const posted = await harness.app.request("/v1/messages", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ text: "あとで" }),
      });

      expect(await posted.json()).toEqual({
        status: "queued",
        sessionUrl: `https://agent.example.com/s/${SESSION_ID}?space=${SPACE_ID}`,
      });

      const reply = await harness.app.request(`/v1/replies/${RUN_ID}`, { headers: bearer(token) });

      expect(reply.status).toBe(404);
    } finally {
      harness.cleanup();
    }
  });

  test("実行中の会話とキューのある会話には投稿しない", async () => {
    const upstream = createUpstream();
    const harness = await setup(upstream.fetchImpl);

    try {
      const { token } = seedConnection(harness);

      upstream.setSession({
        sessionId: SESSION_ID,
        spaceId: SPACE_ID,
        status: "running",
        queueDepth: 0,
      });

      const busy = await harness.app.request("/v1/messages", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ text: "重ねて" }),
      });

      expect(busy.status).toBe(409);
      expect(await busy.json()).toEqual({ error: "session_busy" });

      upstream.setSession({
        sessionId: SESSION_ID,
        spaceId: SPACE_ID,
        status: "idle",
        queueDepth: 1,
      });

      const queued = await harness.app.request("/v1/messages", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ text: "重ねて" }),
      });

      expect(queued.status).toBe(409);

      // GET は 2 回だけで、POST messages は一度も呼ばれていない。
      expect(upstream.calls.filter((call) => call.method === "POST")).toHaveLength(0);
    } finally {
      harness.cleanup();
    }
  });

  test("別のキーからは他人の実行を読めない", async () => {
    const upstream = createUpstream();
    const harness = await setup(upstream.fetchImpl);

    try {
      const first = seedConnection(harness, "A");
      const second = harness.keys.create({ name: "B", connectionId: first.connectionId });

      await harness.app.request("/v1/messages", {
        method: "POST",
        headers: bearer(first.token),
        body: JSON.stringify({ text: "A の依頼" }),
      });

      const reply = await harness.app.request(`/v1/replies/${RUN_ID}`, { headers: bearer(second.token) });

      expect(reply.status).toBe(404);
      expect(await reply.json()).toEqual({ error: "run_not_found" });
    } finally {
      harness.cleanup();
    }
  });

  test("終了済みの実行は上流が落ちていても保存値で答える", async () => {
    const upstream = createUpstream();
    const harness = await setup(upstream.fetchImpl);

    try {
      const { token } = seedConnection(harness);

      await harness.app.request("/v1/messages", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ text: "止めて" }),
      });

      upstream.setSession({
        sessionId: SESSION_ID,
        spaceId: SPACE_ID,
        status: "stopped",
        queueDepth: 0,
        run: { id: RUN_ID, status: "stopped" },
        messages: [],
      });

      const first = await harness.app.request(`/v1/replies/${RUN_ID}`, { headers: bearer(token) });

      expect(await first.json()).toEqual({ status: "stopped" });

      upstream.fail(true);

      const cached = await harness.app.request(`/v1/replies/${RUN_ID}`, { headers: bearer(token) });

      expect(await cached.json()).toEqual({ status: "stopped" });
    } finally {
      harness.cleanup();
    }
  });

  test("上流が接続先と違う応答を返したら 502", async () => {
    const upstream = createUpstream();
    const harness = await setup(upstream.fetchImpl);

    try {
      const { token } = seedConnection(harness);

      upstream.setSession({ sessionId: "aaaaaaaaaa", spaceId: SPACE_ID, status: "idle", queueDepth: 0 });

      const posted = await harness.app.request("/v1/messages", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ text: "hello" }),
      });

      expect(posted.status).toBe(502);
      expect(await posted.json()).toEqual({ error: "upstream_mismatch" });
    } finally {
      harness.cleanup();
    }
  });

  test("失効したキーは 401", async () => {
    const upstream = createUpstream();
    const harness = await setup(upstream.fetchImpl);

    try {
      const { keyId, token } = seedConnection(harness);

      harness.keys.revoke(keyId);

      const response = await harness.app.request("/v1/messages", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ text: "hello" }),
      });

      expect(response.status).toBe(401);
    } finally {
      harness.cleanup();
    }
  });

  test("旧パス (/messages, /replies/:runId) も同じように動く", async () => {
    const upstream = createUpstream();
    const harness = await setup(upstream.fetchImpl);

    try {
      const { token } = seedConnection(harness);

      const posted = await harness.app.request("/messages", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ text: "旧経路" }),
      });

      expect(await posted.json()).toEqual({ runId: RUN_ID });

      upstream.setSession({
        sessionId: SESSION_ID,
        spaceId: SPACE_ID,
        status: "completed",
        queueDepth: 0,
        run: { id: RUN_ID, status: "completed" },
        messages: [{ role: "assistant", text: "OK", assistantId: `${RUN_ID}:0` }],
      });

      const reply = await harness.app.request(`/replies/${RUN_ID}`, { headers: bearer(token) });

      expect(await reply.json()).toEqual({ status: "completed", text: "OK" });
    } finally {
      harness.cleanup();
    }
  });
});
