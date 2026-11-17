import { describe, expect, test } from "bun:test";
import { createApp, healthOf, JUDGMENT_MAX_BYTES, MASTER_UPLOAD_MAX_BYTES, type MasterState } from "../src/server/app";
import type { MasterStore } from "../src/server/master-store";
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

const ENABLED_TEXT = '{ "models": [] }\n';

function fakeStore(overrides: Partial<MasterStore> = {}): MasterStore {
  return {
    ensureSeed: () => {},
    state: () => ({ ok: true, payload: PAYLOAD }),
    raw: (kind) => (kind === "enabled" ? ENABLED_TEXT : null),
    replace: (_kind, text) =>
      text.includes("invalid") ? { ok: false, reason: "json" } : { ok: true, state: { ok: true, payload: PAYLOAD } },
    ...overrides,
  };
}

function appOf(state: MasterState, store: MasterStore = fakeStore()) {
  return createApp({ master: () => state, store });
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

describe("GET /api/master/:kind", () => {
  test("現在のファイルをダウンロードとして返す", async () => {
    const response = await appOf({ ok: true, payload: PAYLOAD }).request("/api/master/enabled");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="enabled.json"');
    expect(await response.text()).toBe(ENABLED_TEXT);
  });

  test("無いファイルと未知の種別は 404", async () => {
    const app = appOf({ ok: true, payload: PAYLOAD });

    expect((await app.request("/api/master/prices")).status).toBe(404);
    expect((await app.request("/api/master/other")).status).toBe(404);
  });
});

describe("PUT /api/master/:kind", () => {
  test("正しい入力を反映し、反映後の鮮度を返す", async () => {
    const response = await appOf({ ok: true, payload: PAYLOAD }).request("/api/master/enabled", {
      method: "PUT",
      body: ENABLED_TEXT,
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      applied: true,
      ok: true,
      service: "cost-master",
      masterFetchedAt: PAYLOAD.fetchedAt,
      version: 4,
    });
  });

  test("不正な入力は理由付きで 400", async () => {
    const response = await appOf({ ok: true, payload: PAYLOAD }).request("/api/master/enabled", {
      method: "PUT",
      body: "this is invalid",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid", reason: "json" });
  });

  test("未知の種別は 404", async () => {
    const response = await appOf({ ok: true, payload: PAYLOAD }).request("/api/master/other", {
      method: "PUT",
      body: "{}",
    });

    expect(response.status).toBe(404);
  });

  test("別オリジンからの書き込みは 403（ブラウザ経由の書き換えを止める）", async () => {
    const response = await appOf({ ok: true, payload: PAYLOAD }).request("/api/master/enabled", {
      method: "PUT",
      body: ENABLED_TEXT,
      headers: { Host: "cost.home.arpa", Origin: "https://evil.example" },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "cross_origin" });
  });

  test("同一オリジンと Origin 無し（curl など）は通す", async () => {
    const app = appOf({ ok: true, payload: PAYLOAD });
    const sameOrigin = await app.request("/api/master/enabled", {
      method: "PUT",
      body: ENABLED_TEXT,
      headers: { Host: "cost.home.arpa", Origin: "https://cost.home.arpa" },
    });

    expect(sameOrigin.status).toBe(200);
  });

  test("上限を超える本文は 413", async () => {
    const response = await appOf({ ok: true, payload: PAYLOAD }).request("/api/master/enabled", {
      method: "PUT",
      body: "x".repeat(MASTER_UPLOAD_MAX_BYTES + 1),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "too_large" });
  });
});

describe("その他", () => {
  test("未知の API パスは JSON で 404", async () => {
    const response = await appOf({ ok: true, payload: PAYLOAD }).request("/api/unknown");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});

describe("PUT /api/judgments", () => {
  const ENDPOINT = "/api/judgments";

  function bodyOf(body: unknown) {
    return {
      method: "PUT",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    };
  }

  function recordingStore(
    raw: () => string | null,
    replaced: { ok: true } | { ok: false; reason: string } = { ok: true },
  ) {
    const written: string[] = [];
    const store = fakeStore({
      raw: () => raw(),
      replace: (_kind, text) => {
        written.push(text);

        return replaced.ok ? { ok: true, state: { ok: true, payload: PAYLOAD } } : replaced;
      },
    });

    return { store, written };
  }

  test("1 行を足して置き換え、applied だけを返す", async () => {
    const { store, written } = recordingStore(() => '{ "models": [] }');
    const response = await appOf({ ok: true, payload: PAYLOAD }, store).request(
      ENDPOINT,
      bodyOf({ modelId: "krea/krea-2-large", enabled: false }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: true });
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] ?? "")).toEqual({ models: [{ modelId: "krea/krea-2-large", enabled: false }] });
  });

  test("有効値が同じなら書かずに 200（.bak を回さない）", async () => {
    const { store, written } = recordingStore(() => JSON.stringify({ models: [{ modelId: "a", enabled: false }] }));
    const response = await appOf({ ok: true, payload: PAYLOAD }, store).request(
      ENDPOINT,
      bodyOf({ modelId: "a", enabled: false }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: true });
    expect(written).toHaveLength(0);
  });

  test("形の違う要求は理由付きで 400", async () => {
    const app = appOf({ ok: true, payload: PAYLOAD });
    const cases: [unknown, string][] = [
      ["this is invalid", "body"],
      [[], "body"],
      [{ enabled: false }, "model-id"],
      [{ modelId: "", enabled: false }, "model-id"],
      [{ modelId: "a", enabled: "false" }, "enabled"],
    ];

    for (const [body, reason] of cases) {
      const response = await app.request(ENDPOINT, bodyOf(body));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid", reason });
    }
  });

  test("落とされる行があるファイルは、要求値によらず 400（rows）", async () => {
    const duplicated = JSON.stringify({
      models: [
        { modelId: "a", enabled: false },
        { modelId: "a", enabled: false },
      ],
    });
    const { store, written } = recordingStore(() => duplicated);
    const response = await appOf({ ok: true, payload: PAYLOAD }, store).request(
      ENDPOINT,
      bodyOf({ modelId: "a", enabled: false }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid", reason: "rows" });
    expect(written).toHaveLength(0);
  });

  test("置き換えが拒否されたら 400（rows）/ 503（master）", async () => {
    const rows = recordingStore(() => JSON.stringify({ models: [] }), { ok: false, reason: "rows" });
    const rowsResponse = await appOf({ ok: true, payload: PAYLOAD }, rows.store).request(
      ENDPOINT,
      bodyOf({ modelId: "a", enabled: false }),
    );

    expect(rowsResponse.status).toBe(400);
    expect(await rowsResponse.json()).toEqual({ error: "invalid", reason: "rows" });

    const master = recordingStore(() => JSON.stringify({ models: [] }), { ok: false, reason: "master" });
    const masterResponse = await appOf({ ok: true, payload: PAYLOAD }, master.store).request(
      ENDPOINT,
      bodyOf({ modelId: "a", enabled: false }),
    );

    expect(masterResponse.status).toBe(503);
    expect(await masterResponse.json()).toEqual({ error: "master_unavailable" });
  });

  test("マスタが読めないときは、要求値によらず 503（no-op でも 200 にしない）", async () => {
    const { store } = recordingStore(() => JSON.stringify({ models: [{ modelId: "a", enabled: false }] }));

    expect((await appOf({ ok: false }, store).request(ENDPOINT, bodyOf({ modelId: "a", enabled: false }))).status).toBe(
      503,
    );
    expect((await appOf({ ok: false }, store).request(ENDPOINT, bodyOf({ modelId: "a", enabled: true }))).status).toBe(
      503,
    );
  });

  test("元のファイルが無い・壊れているときは 503", async () => {
    const missing = recordingStore(() => null);
    const missingResponse = await appOf({ ok: true, payload: PAYLOAD }, missing.store).request(
      ENDPOINT,
      bodyOf({ modelId: "a", enabled: false }),
    );

    expect(missingResponse.status).toBe(503);
    expect(await missingResponse.json()).toEqual({ error: "master_unavailable" });

    const broken = recordingStore(() => "{ not json");
    const brokenResponse = await appOf({ ok: true, payload: PAYLOAD }, broken.store).request(
      ENDPOINT,
      bodyOf({ modelId: "a", enabled: false }),
    );

    expect(brokenResponse.status).toBe(503);
    expect(await brokenResponse.json()).toEqual({ error: "master_unavailable" });
  });

  test("別オリジンは 403、同一オリジンと Origin 無しは通す", async () => {
    const app = appOf({ ok: true, payload: PAYLOAD });
    const crossOrigin = await app.request(ENDPOINT, {
      ...bodyOf({ modelId: "a", enabled: false }),
      headers: { "Content-Type": "application/json", Host: "cost.home.arpa", Origin: "https://evil.example" },
    });

    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.json()).toEqual({ error: "cross_origin" });

    const sameOrigin = await app.request(ENDPOINT, {
      ...bodyOf({ modelId: "a", enabled: false }),
      headers: { "Content-Type": "application/json", Host: "cost.home.arpa", Origin: "https://cost.home.arpa" },
    });

    expect(sameOrigin.status).toBe(200);
  });

  test("上限を超える本文は 413", async () => {
    const response = await appOf({ ok: true, payload: PAYLOAD }).request(ENDPOINT, {
      method: "PUT",
      body: "x".repeat(JUDGMENT_MAX_BYTES + 1),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "too_large" });
  });
});
