// 版の識別子の決め方と、health への載り方。client はこれと自分のビルド識別子を比べるだけで、
// 案内を出すかどうかはここで決まる。

import assert from "node:assert/strict";
import { Hono } from "hono";
import test from "node:test";
import { createBffApp } from "../src/app";
import { serverBuildId } from "../src/build-id";
import { createHealthRoutes } from "../src/routes/health";

function healthRoute(buildId: string) {
  const routes = createHealthRoutes({
    pi: null,
    initError: undefined,
    cwd: "/tmp/project",
    filePreviewPort: 4318,
    previewPort: 4319,
    buildId,
  });
  return new Hono().get("/api/health", routes.health);
}

test("起動時の env で差し替えられる (前後の空白は落とす)", () => {
  assert.equal(serverBuildId({ U7AGENT_BUILD_ID: "fixture-server" }), "fixture-server");
  assert.equal(serverBuildId({ U7AGENT_BUILD_ID: "  fixture-server  ", COMMIT_HASH: "abc1234" }), "fixture-server");
});

test("未設定なら、ビルド時に決まる version とコミットの短縮 SHA を使う", () => {
  const id = serverBuildId({ COMMIT_HASH: "abc1234" });
  assert.ok(id.endsWith("+abc1234"), `コミットが識別子に入っていない: ${id}`);
});

test("コミットも version も取れないときは空文字 (client は案内を出さない)", () => {
  // env を空にしても package.json の version は読めるため、両方落ちる経路は直接は作れない。
  // ここで固定するのは「COMMIT_HASH が無いときは version だけになる」こと
  const id = serverBuildId({});
  assert.ok(!id.includes("+"), `コミットが無いのに識別子が組み立てられている: ${id}`);
});

test("health の応答に識別子を載せる (既存のキーは変えない)", async () => {
  const response = await healthRoute("fixture-server").request("/api/health");
  assert.equal(response.status, 200);
  const body = (await response.json()) as { buildId?: string; ok?: boolean; ready?: boolean };
  assert.equal(body.buildId, "fixture-server");
  assert.equal(body.ok, true);
  assert.equal(body.ready, false);
});

test("createBffApp は指定の識別子を起動時に 1 回だけ決める", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, buildId: "fixture-app" });
  try {
    const body = (await (await bff.app.request("/api/health")).json()) as { buildId?: string };
    assert.equal(body.buildId, "fixture-app");
  } finally {
    await bff.close();
  }
});
