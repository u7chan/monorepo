// リセット枠の取得契機（手動のみ・token 失効時の CLI 更新・失敗時の値の保持）を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeCli } from "../src/server/claude/cli";
import { createClaudeUsageService } from "../src/server/claude/service";
import { loadClaudeResetCredits, openDatabase, saveClaudeResetCredits, type DatabaseHandle } from "../src/server/db";

const NOW = 1_800_000_000_000;
const MINUTE = 60 * 1000;
const AUTH_OK = { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" };
const USAGE_TEXT = [
  "Current session: 12% used · resets Nov 19, 12:50am (America/Los_Angeles)",
  "Current week (all models): 45% used · resets Nov 25, 6am (America/Los_Angeles)",
].join("\n");

const dirs: string[] = [];
const handles: DatabaseHandle[] = [];

function writeCredential(dataDir: string, token: string, expiresAt: number): void {
  mkdirSync(join(dataDir, "claude"), { recursive: true });
  writeFileSync(
    join(dataDir, "claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt } }),
  );
}

function harness(options: { token?: string; expiresAt?: number } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "usage-portal-claude-reset-service-"));
  const db = openDatabase(dataDir);
  const calls: string[][] = [];
  const logs: string[] = [];
  let clock = NOW;

  dirs.push(dataDir);
  handles.push(db);

  writeCredential(dataDir, options.token ?? "token-sentinel", options.expiresAt ?? NOW + 60 * MINUTE);

  const cli: ClaudeCli = {
    run: async (args) => {
      calls.push([...args]);

      if (args[0] === "auth") {
        return JSON.stringify(AUTH_OK);
      }

      // `/usage` を通したら CLI が token を更新した、という状況を作る。
      writeCredential(dataDir, "token-refreshed", NOW + 60 * MINUTE);

      return JSON.stringify({ result: USAGE_TEXT });
    },
  };

  const service = createClaudeUsageService({
    db,
    cli,
    credentialDir: dataDir,
    userAgent: "usage-portal/test",
    now: () => clock,
    log: (message) => logs.push(message),
  });

  return {
    service,
    db,
    dataDir,
    calls,
    logs,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function cedar(grants: unknown[] | null): string {
  return JSON.stringify({ cedar_ember: grants === null ? null : { eligible: true, grants } });
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;

  for (const handle of handles.splice(0)) {
    handle.close();
  }

  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function stubFetch(respond: (headers: Record<string, string>) => Response): string[] {
  const tokens: string[] = [];

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;

    tokens.push(headers.authorization ?? "");

    return respond(headers);
  }) as unknown as typeof fetch;

  return tokens;
}

describe("resetCredits", () => {
  test("有効な token があれば CLI を起こさず、値だけを保存する", async () => {
    const h = harness();
    const endsAt = new Date(NOW + 10 * MINUTE).toISOString();

    stubFetch(() => new Response(cedar([{ resets_left: 2, ends_at: endsAt }]), { status: 200 }));

    await expect(h.service.resetCredits()).resolves.toEqual({ state: "refreshed" });
    expect(h.calls).toEqual([]);
    expect(loadClaudeResetCredits(h.db)).toEqual({
      credits: { available: 2, expiries: [Date.parse(endsAt)] },
      capturedAt: NOW,
      error: null,
    });
  });

  test("token が失効していれば CLI に 1 回だけ更新させ、読み直す", async () => {
    const h = harness({ expiresAt: NOW - MINUTE });
    const endsAt = new Date(NOW + 10 * MINUTE).toISOString();
    const tokens = stubFetch(() => new Response(cedar([{ resets_left: 1, ends_at: endsAt }]), { status: 200 }));

    await expect(h.service.resetCredits()).resolves.toEqual({ state: "refreshed" });
    expect(tokens).toEqual(["Bearer token-refreshed"]);
    expect(h.calls.map((args) => args[0])).toEqual(["auth", "-p"]);
  });

  test("401 は CLI で更新して 1 回だけやり直し、それでも 401 なら失敗にする", async () => {
    const h = harness();
    const tokens = stubFetch(() => new Response("{}", { status: 401 }));

    saveClaudeResetCredits(h.db, { capturedAt: NOW - MINUTE, credits: { available: 1, expiries: [NOW + 1000] } });

    await expect(h.service.resetCredits()).resolves.toEqual({ state: "failed", error: "reauth_required" });
    expect(tokens).toEqual(["Bearer token-sentinel", "Bearer token-refreshed"]);
    expect(h.calls.map((args) => args[0])).toEqual(["auth", "-p"]);

    // 失敗しても前回の値は消さない。
    expect(loadClaudeResetCredits(h.db)).toEqual({
      credits: { available: 1, expiries: [NOW + 1000] },
      capturedAt: NOW - MINUTE,
      error: { code: "reauth_required", message: "Claude のサインインの期限が切れています", at: NOW },
    });
  });

  test("CLI の更新は手動更新と同じ 60 秒の間隔に従う", async () => {
    const h = harness();

    await expect(h.service.refresh("manual")).resolves.toEqual({ state: "refreshed" });

    const callsAfterRefresh = h.calls.length;

    // 直後の操作で token が失効していても、cooldown 中は CLI を起こさない。
    writeCredential(h.dataDir, "token-expired", NOW - MINUTE);

    await expect(h.service.resetCredits()).resolves.toEqual({ state: "failed", error: "reauth_required" });
    expect(h.calls.length).toBe(callsAfterRefresh);
  });

  test("上流エラーと形の変化は、0 件ではなく固定の失敗として残す", async () => {
    const h = harness();

    stubFetch(() => new Response("{}", { status: 500 }));
    await expect(h.service.resetCredits()).resolves.toEqual({ state: "failed", error: "upstream" });

    stubFetch(() => new Response("{}", { status: 200 }));
    await expect(h.service.resetCredits()).resolves.toEqual({ state: "failed", error: "schema" });

    const stored = loadClaudeResetCredits(h.db);

    expect(stored?.credits).toBeNull();
    expect(stored?.error?.code).toBe("schema");
  });

  test("ログアウトでリセット枠も消す", async () => {
    const h = harness();

    saveClaudeResetCredits(h.db, { capturedAt: NOW, credits: { available: 1, expiries: [NOW + 1000] } });

    await expect(h.service.logout()).resolves.toBe(true);
    expect(loadClaudeResetCredits(h.db)).toBeNull();
  });
});
