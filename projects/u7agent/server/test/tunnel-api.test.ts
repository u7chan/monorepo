// 一時共有 API の契約。状態の DTO・ガードの掛かり方・開始 / 停止の分岐・キャッシュを固定する。
// 状態機械そのものは service-tunnel.test.ts、実体の配線は index.ts の起動で確かめる。

import assert from "node:assert/strict";
import test from "node:test";
import { createBffApp } from "../src/app";
import { httpError } from "../src/errors";
import { ServeTunnelStatusSchema, type ServeTunnelStatus } from "../src/schema";
import type { ServeTunnelControl } from "../src/service-tunnel";
import { jsonBody, jsonPost } from "./http-helpers";

function idleStatus(overrides: Partial<ServeTunnelStatus> = {}): ServeTunnelStatus {
  return {
    available: true,
    unavailableReason: null,
    state: "idle",
    provider: "cloudflare-quick",
    active: null,
    lastEnded: null,
    ...overrides,
  };
}

function activeStatus(): ServeTunnelStatus {
  return {
    available: true,
    unavailableReason: null,
    state: "active",
    provider: "cloudflare-quick",
    active: {
      url: "https://quiet-river-a1b2.trycloudflare.com",
      startedAt: 1_000,
      expiresAt: 3_601_000,
      target: { title: "アプリの会話", cwd: "projects/app", command: "pnpm dev" },
    },
    lastEnded: null,
  };
}

function fakeTunnel() {
  let current = idleStatus();
  const starts: Array<{ generation: string; ttlMinutes: number }> = [];
  let failure: unknown = null;
  const control: ServeTunnelControl = {
    status: () => current,
    start: async (input) => {
      starts.push(input);
      if (failure) throw failure;
      current = activeStatus();
      return current;
    },
    stop: async () => {
      current = idleStatus({ lastEnded: { reason: "stopped", at: 2_000 } });
      return current;
    },
    shutdown: async () => {},
  };
  return {
    control,
    starts,
    setStatus: (status: ServeTunnelStatus) => {
      current = status;
    },
    fail: (error: unknown) => {
      failure = error;
    },
  };
}

async function openBff(tunnel: ReturnType<typeof fakeTunnel>) {
  return createBffApp({
    cwd: "/workspace",
    sessionStoreDir: null,
    pi: null,
    workspace: null,
    serveTunnel: tunnel.control,
  });
}

const post = (payload: unknown, origin = "http://app.test") => ({
  ...jsonPost(payload),
  headers: { ...jsonPost(payload).headers, Origin: origin },
});

test("GET は状態を 200 で返し、キャッシュさせない", async () => {
  const tunnel = fakeTunnel();
  const bff = await openBff(tunnel);
  try {
    const response = await bff.app.request("http://app.test/api/serve/tunnel");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await jsonBody(response);
    assert.deepEqual(body, idleStatus());
    assert.equal(ServeTunnelStatusSchema.safeParse(body).success, true);
  } finally {
    await bff.close();
  }
});

test("GET は cross-site の印が付いていても読める (ガードを掛けない)", async () => {
  const tunnel = fakeTunnel();
  const bff = await openBff(tunnel);
  try {
    const response = await bff.app.request("http://app.test/api/serve/tunnel", {
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    assert.equal(response.status, 200);
  } finally {
    await bff.close();
  }
});

test("利用できないときも GET は 200 で理由を返す", async () => {
  const tunnel = fakeTunnel();
  tunnel.setStatus(idleStatus({ available: false, unavailableReason: "cloudflared が見つかりません" }));
  const bff = await openBff(tunnel);
  try {
    const response = await bff.app.request("/api/serve/tunnel");
    assert.equal(response.status, 200);
    const body = await jsonBody(response);
    assert.equal(body.available, false);
    assert.equal(body.unavailableReason, "cloudflared が見つかりません");
  } finally {
    await bff.close();
  }
});

test("start は generation と期限を必須にし、範囲外は 400", async () => {
  const tunnel = fakeTunnel();
  const bff = await openBff(tunnel);
  try {
    for (const payload of [{}, { generation: "gen-1" }, { generation: "gen-1", ttlMinutes: 30 }]) {
      const response = await bff.app.request("http://app.test/api/serve/tunnel/start", post(payload));
      assert.equal(response.status, 400, JSON.stringify(payload));
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.deepEqual(tunnel.starts, []);
  } finally {
    await bff.close();
  }
});

test("start と stop は same-origin の要求だけを受ける", async () => {
  const tunnel = fakeTunnel();
  const bff = await openBff(tunnel);
  try {
    const crossStart = await bff.app.request(
      "http://app.test/api/serve/tunnel/start",
      post({ generation: "gen-1", ttlMinutes: 60 }, "https://evil.test"),
    );
    assert.equal(crossStart.status, 403);
    const crossStop = await bff.app.request("http://app.test/api/serve/tunnel/stop", {
      method: "POST",
      headers: { Origin: "https://evil.test" },
    });
    assert.equal(crossStop.status, 403);
    assert.deepEqual(tunnel.starts, []);
  } finally {
    await bff.close();
  }
});

test("start は active の状態を 200 で返し、GET も同じ状態を読む", async () => {
  const tunnel = fakeTunnel();
  const bff = await openBff(tunnel);
  try {
    const started = await bff.app.request(
      "http://app.test/api/serve/tunnel/start",
      post({ generation: "gen-1", ttlMinutes: 60 }),
    );
    assert.equal(started.status, 200);
    assert.equal(started.headers.get("cache-control"), "no-store");
    assert.deepEqual(await jsonBody(started), activeStatus());
    assert.deepEqual(tunnel.starts, [{ generation: "gen-1", ttlMinutes: 60 }]);

    const status = await jsonBody(await bff.app.request("/api/serve/tunnel"));
    assert.equal(status.state, "active");
    assert.equal(status.active.target.command, "pnpm dev");
  } finally {
    await bff.close();
  }
});

test("stop は冪等に idle を返し、直近の終了を載せる", async () => {
  const tunnel = fakeTunnel();
  const bff = await openBff(tunnel);
  try {
    for (let index = 0; index < 2; index++) {
      const stopped = await bff.app.request("http://app.test/api/serve/tunnel/stop", {
        method: "POST",
        headers: { Origin: "http://app.test" },
      });
      assert.equal(stopped.status, 200);
      assert.equal(stopped.headers.get("cache-control"), "no-store");
      const body = await jsonBody(stopped);
      assert.equal(body.state, "idle");
      assert.deepEqual(body.lastEnded, { reason: "stopped", at: 2_000 });
    }
  } finally {
    await bff.close();
  }
});

test("開始の失敗は httpError の分類をそのまま返し、失敗の理由を載せる", async () => {
  const tunnel = fakeTunnel();
  const bff = await openBff(tunnel);
  try {
    for (const [status, message] of [
      [409, "すでに一時共有を開始しています"],
      [502, "Cloudflare が共有の作成を拒否しました"],
      [503, "一時共有の起動基盤を使えません"],
    ] as const) {
      tunnel.fail(httpError(status, message));
      tunnel.setStatus(
        idleStatus({
          lastEnded: status === 502 ? { reason: "failed", at: 3_000, message } : null,
        }),
      );
      const response = await bff.app.request(
        "http://app.test/api/serve/tunnel/start",
        post({ generation: "gen-1", ttlMinutes: 15 }),
      );
      assert.equal(response.status, status, message);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await jsonBody(response);
      assert.equal(body.error, message);
      const statusBody = await jsonBody(await bff.app.request("/api/serve/tunnel"));
      assert.deepEqual(statusBody.lastEnded, status === 502 ? { reason: "failed", at: 3_000, message } : null);
    }
  } finally {
    await bff.close();
  }
});
