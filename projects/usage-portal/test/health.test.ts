import { afterAll, describe, expect, test } from "bun:test";
import { createApp } from "../src/server/app";
import { createAuthService } from "../src/server/auth";
import { buildHealthReport, type AuthStatus, type DatabaseStatus } from "../src/server/health";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

function appWith(db: DatabaseStatus, auth: AuthStatus) {
  const dataDir = mkdtempSync(join(tmpdir(), "usage-portal-health-"));

  dirs.push(dataDir);

  const service = createAuthService({ dataDir });

  service.ensureSessionKey();

  return createApp({ auth: service, health: () => buildHealthReport(db, auth) });
}

describe("GET /api/health", () => {
  test("DB と認証設定が正常なら 200 と { ok, service, db, auth } を返す", async () => {
    const res = await appWith("ok", "ok").request("/api/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "usage-portal", db: "ok", auth: "ok" });
  });

  test("PIN 未設定（setup_required）は故障ではないので 200 と ok: true を返す", async () => {
    const res = await appWith("ok", "setup_required").request("/api/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "usage-portal", db: "ok", auth: "setup_required" });
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

afterAll(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
