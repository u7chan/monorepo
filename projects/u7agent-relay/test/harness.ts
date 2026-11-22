// テスト用の最小ハーネス。PIN のセットアップ、接続先とキーの作成、上流 fetch の差し替えをまとめる。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { createAuthService } from "../src/server/auth";
import { createConnectionService, createKeyService } from "../src/server/connections";
import { createStore, openDatabase } from "../src/server/db";
import { createRelay } from "../src/server/relay";
import { createUpstreamClient, type FetchLike } from "../src/server/upstream";

export const NOW = 1_800_000_000_000;
export const PIN = "123456";
export const SESSION_ID = "0123456789";
export const SPACE_ID = "default";
export const RUN_ID = "fedcba9876543210";
export const ORIGIN = "https://agent.example.com";
export const SESSION_URL = `${ORIGIN}/s/${SESSION_ID}?space=default`;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function createHarness(options: { fetchImpl?: FetchLike; trustProxy?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "u7agent-relay-test-"));
  const database = openDatabase(dataDir);
  const store = createStore(database);
  const auth = createAuthService({ dataDir, now: () => NOW });
  auth.ensureSessionKey();

  const upstream = createUpstreamClient({
    fetchImpl: options.fetchImpl ?? (async () => jsonResponse({ error: "unexpected fetch" }, 500)),
    timeoutMs: 2_000,
  });
  const relay = createRelay({ store, upstream, now: () => NOW });
  const connections = createConnectionService({ store, upstream, now: () => NOW });
  const keys = createKeyService({ store, now: () => NOW });

  const app = createApp({
    auth,
    store,
    relay,
    connections,
    keys,
    version: "test",
    now: () => NOW,
    ...(options.trustProxy ? { trustProxy: true } : { clientKey: () => "test-client" }),
  });

  return {
    app,
    store,
    auth,
    relay,
    upstream,
    connections,
    keys,
    dataDir,
    cleanup() {
      database.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export type Harness = ReturnType<typeof createHarness>;

/** 管理画面の操作と同じ条件にするため、Origin を付けた JSON 要求を送る。 */
export function adminRequest(harmess: Harness, path: string, init: RequestInit = {}): Promise<Response> {
  return Promise.resolve(
    harmess.app.request(path, {
      ...init,
      headers: {
        Origin: "http://localhost",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
    }),
  );
}

/** PIN をセットアップして cookie を返す。管理 API の前提を 1 か所にまとめる。 */
export async function setupAdmin(harmess: Harness): Promise<string> {
  const response = await adminRequest(harmess, "/api/auth/setup", {
    method: "POST",
    body: JSON.stringify({ pin: PIN }),
  });

  const cookie = response.headers.get("set-cookie")?.split(";")[0];

  if (!cookie) {
    throw new Error(`セットアップに失敗しました: ${response.status}`);
  }

  return cookie;
}

/** 接続先とキーを 1 組作り、平文トークンを返す。 */
export function seedConnection(
  harmess: Harness,
  name = "検証用",
): { connectionId: string; token: string; keyId: string } {
  const connection = harmess.connections.addFromUrl(name, SESSION_URL);
  const { key, token } = harmess.keys.create({ name: `${name} キー`, connectionId: connection.id });

  return { connectionId: connection.id, token, keyId: key.id };
}

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}
