import assert from "node:assert/strict";
import test from "node:test";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { bodyGuard, jsonBodyValidator, requestBodyValidationHook, respondSettingsMutation } from "../src/http";

const schema = z.object({ name: z.string() });
const app = new Hono()
  .use("/api/*", bodyGuard)
  .post("/api/body", jsonBodyValidator(schema, requestBodyValidationHook), (c) => c.json(c.req.valid("json")))
  .post("/api/hono", zValidator("json", schema, requestBodyValidationHook), (c) => c.json(c.req.valid("json")));

function post(path: string, contentType: string, body: object) {
  return app.request(path, { method: "POST", headers: { "Content-Type": contentType }, body: JSON.stringify(body) });
}

test("両方の validator がスキーマに通らない JSON に同じ 400 を返す", async () => {
  for (const path of ["/api/body", "/api/hono"]) {
    const response = await post(path, "application/json", { name: 42 });
    assert.equal(response.status, 400, path);
    assert.deepEqual(await response.json(), { error: "Invalid request body" }, path);
  }
});

test("検証フックを共有しても、JSON 以外の Content-Type で本文を読むかは validator ごとに変わらない", async () => {
  const body = { name: "example" };
  for (const [path, contentType] of [
    ["/api/body", "application/json"],
    ["/api/hono", "application/json"],
    ["/api/body", "text/plain"],
  ] as const) {
    const response = await post(path, contentType, body);
    assert.equal(response.status, 200, `${path} ${contentType}`);
    assert.deepEqual(await response.json(), body);
  }
  const response = await post("/api/hono", "text/plain", body);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid request body" });
});

test("設定変更は成功 DTO をそのまま返し、保存できなかった 503 にだけ not_stored を付ける", async () => {
  const cases = [
    [
      { status: 200, response: { state: "applied", enabled: true } },
      { state: "applied", enabled: true },
    ],
    [{ status: 400, error: "invalid input" }, { error: "invalid input" }],
    [
      { status: 503, error: "store unavailable" },
      { error: "store unavailable", state: "not_stored" },
    ],
  ] as const;
  for (const [outcome, body] of cases) {
    const app = new Hono().put("/", (c) => respondSettingsMutation(c, outcome));
    const response = await app.request("/", { method: "PUT" });
    assert.equal(response.status, outcome.status);
    assert.deepEqual(await response.json(), body);
  }
});
