// GET /api/runtime/environment の公開契約を app.request() で検証する。
// 6 状態・未設定・契約外応答・秘密非公開・診断専用タイムアウト (応答なし / 本文停止) をスタブで再現する。

import assert from "node:assert/strict";
import test from "node:test";
import type { Hono } from "hono";
import { createBffApp } from "../src/app";
import { createSandboxToolClient, SandboxRuntimeError, type SandboxRuntimeDiagnostics } from "../src/sandbox/client";
import type { SandboxRuntimeInfo } from "../src/sandbox/protocol";

const INFO: SandboxRuntimeInfo = {
  environment: {
    os: "Debian GNU/Linux 13 (trixie)",
    arch: "x86_64",
    user: "node",
    isRoot: false,
    workspace: "/workspace",
  },
  commands: [
    { name: "curl", version: "8.14.1" },
    { name: "node", version: "24.18.0" },
    { name: "npm", version: null },
  ],
};

async function createApp(runtimeDiagnostics: SandboxRuntimeDiagnostics | null): Promise<Hono> {
  const bff = await createBffApp({
    cwd: "/tmp/project",
    sessionStoreDir: null,
    pi: null,
    workspace: null,
    runtimeDiagnostics,
  });
  return bff.app;
}

async function readEnvironment(app: Hono): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await app.request("/api/runtime/environment");
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

function failingDiagnostics(failure: "unreachable" | "unauthorized" | "timeout" | "probe_failed", message: string) {
  return {
    getRuntimeInfo: async (): Promise<SandboxRuntimeInfo> => {
      throw new SandboxRuntimeError(message, failure);
    },
  };
}

test("returns not_configured with HTTP 200 when the BFF has no sandbox diagnostics", async () => {
  const app = await createApp(null);
  const { status, body } = await readEnvironment(app);
  assert.equal(status, 200);
  assert.deepEqual(body, { state: "not_configured" });
});

test("returns the sandbox environment and commands as connected", async () => {
  const app = await createApp({ getRuntimeInfo: async () => INFO });
  const { status, body } = await readEnvironment(app);
  assert.equal(status, 200);
  assert.deepEqual(body, { state: "connected", environment: INFO.environment, commands: INFO.commands });
});

test("maps every failure classification to its own state without leaking details", async () => {
  const cases = ["unreachable", "unauthorized", "timeout", "probe_failed"] as const;
  for (const failure of cases) {
    const app = await createApp(
      failingDiagnostics(failure, `http://sandbox.internal:8080 token=super-secret-0123456789 ${failure}`),
    );
    const { status, body, text } = await readEnvironment(app);
    assert.equal(status, 200);
    assert.deepEqual(body, { state: failure });
    assert.equal(text.includes("sandbox.internal"), false, "サンドボックスの URL を出さない");
    assert.equal(text.includes("super-secret"), false, "共有トークンを出さない");
  }
});

test("maps a contract-violating sandbox response to probe_failed", async () => {
  const app = await createApp({
    getRuntimeInfo: async () => ({ environment: { os: 1 }, commands: [{ name: "curl" }] }) as never,
  });
  const { status, body } = await readEnvironment(app);
  assert.equal(status, 200);
  assert.deepEqual(body, { state: "probe_failed" });
});

test("classifies non-OK sandbox responses without exposing the body", async () => {
  const unauthorizedApp = await createApp(
    createSandboxToolClient({
      baseUrl: "http://sandbox.test:8080",
      token: "runtime-test-token-0123456789",
      fetchImpl: (async () => new Response("token=super-secret", { status: 401 })) as typeof fetch,
    }),
  );
  const unauthorized = await readEnvironment(unauthorizedApp);
  assert.equal(unauthorized.status, 200);
  assert.deepEqual(unauthorized.body, { state: "unauthorized" });
  assert.equal(unauthorized.text.includes("super-secret"), false);

  const brokenApp = await createApp(
    createSandboxToolClient({
      baseUrl: "http://sandbox.test:8080",
      token: "runtime-test-token-0123456789",
      fetchImpl: (async () => new Response("invalid json", { status: 200 })) as typeof fetch,
    }),
  );
  const broken = await readEnvironment(brokenApp);
  assert.equal(broken.status, 200);
  assert.deepEqual(broken.body, { state: "probe_failed" });

  const downApp = await createApp(
    createSandboxToolClient({
      baseUrl: "http://sandbox.test:8080",
      token: "runtime-test-token-0123456789",
      fetchImpl: (async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8080");
      }) as typeof fetch,
    }),
  );
  const down = await readEnvironment(downApp);
  assert.equal(down.status, 200);
  assert.deepEqual(down.body, { state: "unreachable" });
});

test("aborts the diagnostics request when the sandbox never responds", async () => {
  const signals: Array<AbortSignal | null | undefined> = [];
  const app = await createApp(
    createSandboxToolClient({
      baseUrl: "http://sandbox.test:8080",
      token: "runtime-test-token-0123456789",
      runtimeInfoTimeoutMs: 50,
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        signals.push(init?.signal);
        return new Promise<Response>(() => {});
      }) as typeof fetch,
    }),
  );
  const began = Date.now();
  const { status, body } = await readEnvironment(app);
  assert.equal(status, 200);
  assert.deepEqual(body, { state: "timeout" });
  assert.ok(Date.now() - began < 2000);
  assert.equal(signals[0]?.aborted, true, "期限超過でサンドボックスへの要求を中断する");
});

test("classifies non-2xx responses without waiting for the body cancel to finish", async () => {
  const cases = [
    [401, "unauthorized"],
    [500, "probe_failed"],
  ] as const;
  for (const [httpStatus, state] of cases) {
    const app = await createApp(
      createSandboxToolClient({
        baseUrl: "http://sandbox.test:8080",
        token: "runtime-test-token-0123456789",
        runtimeInfoTimeoutMs: 20,
        fetchImpl: (async () =>
          new Response(
            // cancel() が完了しない本文。ここを待つと期限を超えても getRuntimeInfo が解決しない
            new ReadableStream<Uint8Array>({ cancel: () => new Promise<void>(() => {}) }),
            { status: httpStatus },
          )) as typeof fetch,
      }),
    );
    const began = Date.now();
    const outcome = await Promise.race([
      readEnvironment(app),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    assert.ok(outcome, `HTTP ${httpStatus} の失敗分類を期限内に返す`);
    assert.equal(outcome.status, 200);
    assert.deepEqual(outcome.body, { state });
    assert.ok(Date.now() - began < 1000, `本文の解放を待たない (elapsed=${Date.now() - began}ms)`);
  }
});

test("aborts when the response headers arrive but the body never completes", async () => {
  const signals: Array<AbortSignal | null | undefined> = [];
  const app = await createApp(
    createSandboxToolClient({
      baseUrl: "http://sandbox.test:8080",
      token: "runtime-test-token-0123456789",
      runtimeInfoTimeoutMs: 50,
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        signals.push(init?.signal);
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    }),
  );
  const began = Date.now();
  const { status, body } = await readEnvironment(app);
  assert.equal(status, 200);
  assert.deepEqual(body, { state: "timeout" });
  assert.ok(Date.now() - began < 2000);
  // abort が本文の受信を打ち切り、接続を解放する (本文は JSON として読めない)
  assert.equal(signals[0]?.aborted, true);
});

test("keeps the diagnostics timeout independent from the existing health and models contracts", async () => {
  const app = await createApp(
    createSandboxToolClient({
      baseUrl: "http://sandbox.test:8080",
      token: "runtime-test-token-0123456789",
      runtimeInfoTimeoutMs: 50,
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        assert.ok(init?.signal, "診断経路だけが signal を受け取る");
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(JSON.stringify(INFO)));
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch,
    }),
  );
  const environment = await readEnvironment(app);
  assert.equal(environment.body.state, "connected");

  const health = await app.request("/api/health");
  assert.equal(health.status, 200);
  const healthBody = (await health.json()) as Record<string, unknown>;
  assert.equal(healthBody.sandboxConfigured, false, "health の sandboxConfigured は設定の有無のまま");

  const models = await app.request("/api/runtime/models");
  assert.equal(models.status, 503);
  assert.deepEqual(await models.json(), { error: "ランタイムのモデル情報を取得できません" });
});
