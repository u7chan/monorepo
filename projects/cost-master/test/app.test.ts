import { describe, expect, test } from "bun:test";
import { createApp, healthOf, type MasterState } from "../src/server/app";
import type { CostMasterPayload } from "../src/shared/contract";

const PAYLOAD: CostMasterPayload = {
  version: 4,
  fetchedAt: 1_794_600_000_000,
  models: [
    {
      provider: "openrouter",
      modelId: "krea/krea-2-large",
      billable: "output_image",
      unit: "image",
      variant: "",
      costUsd: 0.06,
      currency: "USD",
      enabled: true,
      note: null,
    },
  ],
};

function appOf(state: MasterState) {
  return createApp({ master: () => state });
}

describe("GET /api/models", () => {
  test("契約どおりの形で返し、enabled を欠落させない", async () => {
    const response = await appOf({ ok: true, payload: PAYLOAD }).request("/api/models");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(PAYLOAD);
  });

  test("epoch ms・USD・provider を固定で返す", async () => {
    const response = await appOf({ ok: true, payload: PAYLOAD }).request("/api/models");
    const body = (await response.json()) as CostMasterPayload;

    expect(Number.isInteger(body.fetchedAt)).toBe(true);
    expect(body.fetchedAt).toBeGreaterThan(1_000_000_000_000);
    expect(body.models.every((model) => model.currency === "USD" && model.provider === "openrouter")).toBe(true);
  });

  test("応答をキャッシュさせず、API のセキュリティヘッダーを付ける", async () => {
    const response = await appOf({ ok: true, payload: PAYLOAD }).request("/api/models");

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  });

  test("マスタを読めていないときは空の一覧ではなく 503 にする", async () => {
    const response = await appOf({ ok: false }).request("/api/models");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "master_unavailable" });
  });
});

describe("GET /api/health", () => {
  test("価格とモデル一覧を含めず、鮮度だけ返す", async () => {
    const response = await appOf({ ok: true, payload: PAYLOAD }).request("/api/health");
    const body = await response.json();

    expect(body).toEqual({ ok: true, service: "cost-master", masterFetchedAt: PAYLOAD.fetchedAt, version: 4 });
    expect(JSON.stringify(body)).not.toContain("krea/krea-2-large");
  });

  test("マスタを読めていないときは ok: false と null を返す", async () => {
    expect(healthOf({ ok: false })).toEqual({
      ok: false,
      service: "cost-master",
      masterFetchedAt: null,
      version: null,
    });
  });
});

describe("その他", () => {
  test("未知の API パスは JSON で 404", async () => {
    const response = await appOf({ ok: true, payload: PAYLOAD }).request("/api/unknown");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});
