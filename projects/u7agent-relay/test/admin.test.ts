// 管理 API の認証・接続先とキーの CRUD・中継との連動を固定する。
import { describe, expect, test } from "bun:test";
import {
  adminRequest,
  bearer,
  createHarness,
  jsonResponse,
  PIN,
  SESSION_ID,
  RUN_ID,
  SESSION_URL,
  setupAdmin,
  SPACE_ID,
  type Harness,
} from "./harness";

async function state(harness: Harness, cookie: string) {
  const response = await adminRequest(harness, "/api/state", { headers: { Cookie: cookie } });

  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function jsonBody(body: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}

describe("管理 API", () => {
  test("未ログインでは state を読めない", async () => {
    const harness = createHarness();

    try {
      const response = await adminRequest(harness, "/api/state");

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    } finally {
      harness.cleanup();
    }
  });

  test("誤った PIN は 401、正しい PIN は cookie を発行する", async () => {
    const harness = createHarness();

    try {
      await setupAdmin(harness);

      const wrong = await adminRequest(harness, "/api/auth/login", jsonBody({ pin: "000000" }));

      expect(wrong.status).toBe(401);
      expect(await wrong.json()).toEqual({ error: "invalid_pin" });

      const right = await adminRequest(harness, "/api/auth/login", jsonBody({ pin: PIN }));
      const cookie = right.headers.get("set-cookie") ?? "";

      expect(right.status).toBe(200);
      expect(cookie).toContain("u7agent_relay_session=");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
    } finally {
      harness.cleanup();
    }
  });

  test("Origin の無い変更要求は 403", async () => {
    const harness = createHarness();

    try {
      const cookie = await setupAdmin(harness);
      const response = await harness.app.request("/api/connections", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x", sessionUrl: SESSION_URL }),
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "origin_mismatch" });
    } finally {
      harness.cleanup();
    }
  });

  test("接続先を登録し、キーを発行し、state に秘密を載せない", async () => {
    const harness = createHarness();

    try {
      const cookie = await setupAdmin(harness);

      const added = await adminRequest(harness, "/api/connections", {
        ...jsonBody({ name: "開発機", sessionUrl: SESSION_URL }),
        headers: { Cookie: cookie },
      });

      expect(added.status).toBe(201);

      const created = (await added.json()) as { connection: { id: string; sessionUrl: string; keyCount: number } };

      expect(created.connection.sessionUrl).toBe(SESSION_URL);
      expect(created.connection.keyCount).toBe(0);

      const issued = await adminRequest(harness, "/api/keys", {
        ...jsonBody({ name: "Muse", connectionId: created.connection.id }),
        headers: { Cookie: cookie },
      });

      expect(issued.status).toBe(201);

      const { key, token } = (await issued.json()) as {
        key: { prefix: string; revokedAt: number | null };
        token: string;
      };

      expect(token.startsWith("ur_")).toBe(true);
      expect(token).toHaveLength(46);
      expect(key.prefix).toBe(token.slice(0, 11));
      expect(key.revokedAt).toBeNull();

      const { status, body } = await state(harness, cookie);

      expect(status).toBe(200);
      expect(JSON.stringify(body)).not.toContain(token);
      expect((body.keys as { prefix: string }[])[0]?.prefix).toBe(key.prefix);
      expect((body.connections as { keyCount: number }[])[0]?.keyCount).toBe(1);
    } finally {
      harness.cleanup();
    }
  });

  test("同じ会話の重複登録は 409、URL 不正は 400", async () => {
    const harness = createHarness();

    try {
      const cookie = await setupAdmin(harness);

      const first = await adminRequest(harness, "/api/connections", {
        ...jsonBody({ name: "A", sessionUrl: SESSION_URL }),
        headers: { Cookie: cookie },
      });

      expect(first.status).toBe(201);

      const duplicate = await adminRequest(harness, "/api/connections", {
        ...jsonBody({ name: "B", sessionUrl: SESSION_URL }),
        headers: { Cookie: cookie },
      });

      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toEqual({ error: "duplicate_connection" });

      const invalid = await adminRequest(harness, "/api/connections", {
        ...jsonBody({ name: "C", sessionUrl: "http://agent.example.com/s/0123456789" }),
        headers: { Cookie: cookie },
      });

      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: "invalid_session_url" });
    } finally {
      harness.cleanup();
    }
  });

  test("疎通確認は上流の状態とタイトルを返す", async () => {
    const fetchImpl = async () =>
      jsonResponse({
        sessionId: SESSION_ID,
        spaceId: SPACE_ID,
        status: "idle",
        queueDepth: 0,
        title: "調査用の会話",
      });
    const harness = createHarness({ fetchImpl });

    try {
      const cookie = await setupAdmin(harness);
      const added = await adminRequest(harness, "/api/connections", {
        ...jsonBody({ name: "疎通", sessionUrl: SESSION_URL }),
        headers: { Cookie: cookie },
      });
      const { connection } = (await added.json()) as { connection: { id: string } };

      const checked = await adminRequest(harness, `/api/connections/${connection.id}/check`, {
        method: "POST",
        headers: { Cookie: cookie },
      });

      expect(checked.status).toBe(200);
      expect(await checked.json()).toEqual({
        status: "idle",
        title: "調査用の会話",
        queueDepth: 0,
        awaitingAnswer: false,
        sessionUrl: SESSION_URL,
        checkedAt: 1_800_000_000_000,
      });
    } finally {
      harness.cleanup();
    }
  });

  test("u7agent に会話を作らせて接続先にできる", async () => {
    const calls: { url: string; body: string | null }[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: typeof init?.body === "string" ? init.body : null });

      return jsonResponse({ sessionId: "abcdef0123", spaceId: "default" }, 201);
    };
    const harness = createHarness({ fetchImpl });

    try {
      const cookie = await setupAdmin(harness);
      const response = await adminRequest(harness, "/api/connections/create", {
        ...jsonBody({ name: "新規", origin: "https://agent.example.com", spaceId: "default" }),
        headers: { Cookie: cookie },
      });

      expect(response.status).toBe(201);

      const { connection } = (await response.json()) as {
        connection: { sessionId: string; sessionUrl: string };
      };

      expect(connection.sessionId).toBe("abcdef0123");
      expect(connection.sessionUrl).toBe("https://agent.example.com/s/abcdef0123?space=default");
      expect(calls[0]?.url).toBe("https://agent.example.com/api/sessions");
      expect(calls[0]?.body).toBe("{}");
    } finally {
      harness.cleanup();
    }
  });

  test("キーを失効すると中継は 401、接続先を削除するとキーも消える", async () => {
    const upstreamFetch = async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? jsonResponse({ queued: false, runId: RUN_ID }, 202)
        : jsonResponse({ sessionId: SESSION_ID, spaceId: SPACE_ID, status: "idle", queueDepth: 0 });
    const harness = createHarness({ fetchImpl: upstreamFetch });

    try {
      const cookie = await setupAdmin(harness);
      const added = await adminRequest(harness, "/api/connections", {
        ...jsonBody({ name: "削除対象", sessionUrl: SESSION_URL }),
        headers: { Cookie: cookie },
      });
      const { connection } = (await added.json()) as { connection: { id: string } };
      const issued = await adminRequest(harness, "/api/keys", {
        ...jsonBody({ name: "キー", connectionId: connection.id }),
        headers: { Cookie: cookie },
      });
      const { key, token } = (await issued.json()) as { key: { id: string }; token: string };

      const before = await harness.app.request("/v1/messages", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ text: "hello" }),
      });

      expect(before.status).toBe(202);

      const revoked = await adminRequest(harness, `/api/keys/${key.id}/revoke`, {
        method: "POST",
        headers: { Cookie: cookie },
      });

      expect(revoked.status).toBe(200);

      const after = await harness.app.request("/v1/messages", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ text: "hello" }),
      });

      expect(after.status).toBe(401);

      const deleted = await adminRequest(harness, `/api/connections/${connection.id}`, {
        method: "DELETE",
        headers: { Cookie: cookie },
      });

      expect(await deleted.json()).toEqual({ deletedKeys: 1 });
      expect(harness.store.listKeys()).toHaveLength(0);
    } finally {
      harness.cleanup();
    }
  });
});
