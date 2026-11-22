// 上流応答の検証とタイムアウトの契約を固定する。
import { describe, expect, test } from "bun:test";
import { createUpstreamClient, type FetchLike } from "../src/server/upstream";

const TARGET = { origin: "https://agent.example.com", sessionId: "0123456789", spaceId: "default" };
const RUN_ID = "fedcba9876543210";

function respond(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("upstream", () => {
  test("ヘッダー待ちの期限切れは 504 upstream_timeout", async () => {
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      })) as FetchLike;
    const upstream = createUpstreamClient({ fetchImpl, timeoutMs: 10 });

    await expect(upstream.readSession(TARGET)).rejects.toMatchObject({
      status: 504,
      code: "upstream_timeout",
    });
  });

  test("本文読み取りの期限切れも 504 upstream_timeout", async () => {
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      } as Response)) as FetchLike;
    const upstream = createUpstreamClient({ fetchImpl, timeoutMs: 10 });

    await expect(upstream.readSession(TARGET)).rejects.toMatchObject({
      status: 504,
      code: "upstream_timeout",
    });
  });

  test("投稿の応答が別の会話を指したら 502 upstream_mismatch", async () => {
    const upstream = createUpstreamClient({
      fetchImpl: respond({ sessionId: "aaaaaaaaaa", queued: false, runId: RUN_ID }, 202),
    });

    await expect(upstream.postMessage(TARGET, "hello")).rejects.toMatchObject({
      status: 502,
      code: "upstream_mismatch",
    });
  });

  test("queued の応答でも会話の一致を確認する", async () => {
    const upstream = createUpstreamClient({
      fetchImpl: respond({ sessionId: "aaaaaaaaaa", queued: true }, 202),
    });

    await expect(upstream.postMessage(TARGET, "hello")).rejects.toMatchObject({
      status: 502,
      code: "upstream_mismatch",
    });
  });

  test("接続できない場合は 502 upstream_unavailable", async () => {
    const upstream = createUpstreamClient({
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });

    await expect(upstream.readSession(TARGET)).rejects.toMatchObject({
      status: 502,
      code: "upstream_unavailable",
    });
  });
});
