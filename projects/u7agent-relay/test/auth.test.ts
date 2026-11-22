// PIN 認証の状態遷移と cookie の無効化条件を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthService } from "../src/server/auth";
import { hashPin } from "../src/server/pin";
import { SESSION_COOKIE_NAME } from "../src/server/session";

const dirs: string[] = [];
const PIN = "135790";
const now = 1_800_000_000_000;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "u7agent-relay-auth-"));

  dirs.push(dir);

  return dir;
}

function service(dataDir = tempDir()) {
  const auth = createAuthService({ dataDir, now: () => now });

  auth.ensureSessionKey();

  return { auth, dataDir };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("PIN 認証", () => {
  test("未設定は setup_required、設定後は ok", async () => {
    const { auth } = service();

    expect(auth.status()).toBe("setup_required");

    const result = await auth.setup(PIN);

    expect(result.ok).toBe(true);
    expect(auth.status()).toBe("ok");
  });

  test("設定後の再 setup は拒否し、正しい PIN だけログインできる", async () => {
    const { auth } = service();

    await auth.setup(PIN);

    expect(await auth.setup("246810")).toEqual({ ok: false, reason: "already_configured" });
    expect(await auth.login("000000")).toEqual({ ok: false, reason: "invalid_pin" });
    expect((await auth.login(PIN)).ok).toBe(true);
  });

  test("6 桁でない PIN は setup も login も拒否する", async () => {
    const { auth } = service();

    expect(await auth.setup("12345")).toEqual({ ok: false, reason: "invalid_pin" });

    await auth.setup(PIN);

    expect(await auth.login("1234567")).toEqual({ ok: false, reason: "invalid_pin" });
  });

  test("PIN ハッシュが壊れていれば misconfigured", () => {
    const { auth, dataDir } = service();

    writeFileSync(join(dataDir, "pin-hash"), "$argon2id$broken\n");

    expect(auth.status()).toBe("misconfigured");
  });

  test("PIN ハッシュとセッション鍵の両方が無ければ setup_required に戻る", async () => {
    const { auth, dataDir } = service();

    await auth.setup(PIN);
    rmSync(join(dataDir, "pin-hash"));
    rmSync(join(dataDir, "session-key"));

    expect(auth.status()).toBe("setup_required");
    expect((await auth.setup("246810")).ok).toBe(true);
  });

  test("PIN ハッシュがあってセッション鍵が無ければ misconfigured", async () => {
    const { auth, dataDir } = service();

    await auth.setup(PIN);
    rmSync(join(dataDir, "session-key"));

    expect(auth.status()).toBe("misconfigured");
  });

  test("PIN を変えると既存 cookie は無効になる", async () => {
    const { auth, dataDir } = service();
    const result = await auth.setup(PIN);

    if (!result.ok) {
      throw new Error("setup に失敗しました");
    }

    const cookie = `${SESSION_COOKIE_NAME}=${result.token}`;

    expect(auth.readSession(cookie)?.expiresAt).toBe(now + 30 * 24 * 60 * 60 * 1000);

    // 別の PIN のハッシュへ差し替える。署名鍵に PIN ハッシュを混ぜているので token は通らない。
    writeFileSync(join(dataDir, "pin-hash"), `${await hashPin("246810")}\n`);

    expect(auth.readSession(cookie)).toBeNull();
  });
});
