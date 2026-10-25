import { describe, expect, test } from "bun:test";
import { createApp } from "../src/server/app";
import { buildHealthReport, type AuthStatus, type DatabaseStatus } from "../src/server/health";

function appWith(db: DatabaseStatus, auth: AuthStatus) {
  return createApp({ health: () => buildHealthReport(db, auth) });
}

describe("GET /api/health", () => {
  test("DB と認証設定が正常なら 200 と { ok, service, db, auth } を返す", async () => {
    const res = await appWith("ok", "ok").request("/api/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "usage-portal", db: "ok", auth: "ok" });
  });

  test("DB が error なら 503 と db: error を返す", async () => {
    const res = await appWith("error", "ok").request("/api/health");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      service: "usage-portal",
      db: "error",
      auth: "ok",
    });
  });

  test("認証設定が不正なら 503 と auth: misconfigured を返す", async () => {
    const res = await appWith("ok", "misconfigured").request("/api/health");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      service: "usage-portal",
      db: "ok",
      auth: "misconfigured",
    });
  });

  test("利用枠の項目を返さず、Cache-Control: no-store を付ける", async () => {
    const res = await appWith("ok", "ok").request("/api/health");

    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys((await res.json()) as Record<string, unknown>).sort()).toEqual(["auth", "db", "ok", "service"]);
  });

  test("利用枠の API はまだ公開していない", async () => {
    expect((await appWith("ok", "ok").request("/api/usage")).status).toBe(404);
  });
});
