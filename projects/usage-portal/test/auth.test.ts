// 認証サービスの状態遷移（未設定 → 設定済み）、PIN 照合、cookie の無効化条件を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthService } from "../src/server/auth";
import { SESSION_COOKIE_NAME } from "../src/server/session";

const dirs: string[] = [];
const PIN = "123456";
const now = 1_800_000_000_000;

function service(dataDir = tempDir()) {
  const auth = createAuthService({ dataDir, now: () => now });

  auth.ensureSessionKey();

  return { auth, dataDir };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "usage-portal-auth-service-"));

  dirs.push(dir);

  return dir;
}

function cookieHeader(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`;
}

async function setupWithPin(auth: ReturnType<typeof createAuthService>): Promise<string> {
  const result = await auth.setup(PIN);

  if (!result.ok) {
    throw new Error(`setup に失敗しました: ${result.reason}`);
  }

  return result.token;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("status", () => {
  test("PIN 未設定なら setup_required、設定後は ok", async () => {
    const { auth } = service();

    expect(auth.status()).toBe("setup_required");

    await setupWithPin(auth);

    expect(auth.status()).toBe("ok");
  });

  test("PIN ハッシュが壊れていれば misconfigured", () => {
    const { auth, dataDir } = service();

    writeFileSync(join(dataDir, "pin-hash"), "garbage\n");

    expect(auth.status()).toBe("misconfigured");
  });
});

describe("setup", () => {
  test("6 桁でない PIN は invalid_pin、設定済みなら already_configured", async () => {
    const { auth } = service();

    expect(await auth.setup("12345")).toEqual({ ok: false, reason: "invalid_pin" });

    await setupWithPin(auth);

    expect(await auth.setup(PIN)).toEqual({ ok: false, reason: "already_configured" });
  });

  test("発行した cookie でセッションを読める", async () => {
    const { auth } = service();
    const token = await setupWithPin(auth);

    expect(auth.readSession(cookieHeader(token))).toEqual({ expiresAt: now + 30 * 24 * 60 * 60 * 1000 });
  });
});

describe("login", () => {
  test("PIN 未設定では setup_required、違う PIN は invalid_pin", async () => {
    const { auth } = service();

    expect(await auth.login(PIN)).toEqual({ ok: false, reason: "setup_required" });

    await setupWithPin(auth);

    expect(await auth.login("654321")).toEqual({ ok: false, reason: "invalid_pin" });
    expect(await auth.login("12345")).toEqual({ ok: false, reason: "invalid_pin" });
  });

  test("一致すればセッションを発行する", async () => {
    const { auth } = service();

    await setupWithPin(auth);

    const result = await auth.login(PIN);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(auth.readSession(cookieHeader(result.token))).not.toBeNull();
    }
  });
});

describe("readSession", () => {
  test("PIN ハッシュのファイルを消すと未設定に戻り、既存の cookie も通らない", async () => {
    const { auth, dataDir } = service();
    const token = await setupWithPin(auth);

    rmSync(join(dataDir, "pin-hash"));

    expect(auth.status()).toBe("setup_required");
    expect(auth.readSession(cookieHeader(token))).toBeNull();
  });

  test("PIN を設定し直すと、前の PIN で発行した cookie は通らない", async () => {
    const { auth, dataDir } = service();
    const token = await setupWithPin(auth);

    rmSync(join(dataDir, "pin-hash"));

    const second = await setupWithPin(auth);

    expect(auth.readSession(cookieHeader(token))).toBeNull();
    expect(auth.readSession(cookieHeader(second))).not.toBeNull();
  });

  test("セッション鍵を差し替えると既存の cookie は通らない", async () => {
    const { auth, dataDir } = service();
    const token = await setupWithPin(auth);

    rmSync(join(dataDir, "session-key"));
    auth.ensureSessionKey();

    expect(auth.readSession(cookieHeader(token))).toBeNull();
  });
});
