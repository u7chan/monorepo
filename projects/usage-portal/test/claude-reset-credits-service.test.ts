// リセット枠の取得契機（手動のみ・token 失効時の CLI 更新・失敗時の値の保持）を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCliError, type ClaudeCli } from "../src/server/claude/cli";
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

function harness(
  options: {
    token?: string;
    expiresAt?: number;
    cliVersion?: string | null;
    /** `--version` をここで止めて、待っている間の操作を固定する。 */
    versionGate?: Promise<void>;
  } = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), "usage-portal-claude-reset-service-"));
  const db = openDatabase(dataDir);
  const calls: string[][] = [];
  const logs: string[] = [];
  let clock = NOW;

  dirs.push(dataDir);
  handles.push(db);

  writeCredential(dataDir, options.token ?? "token-sentinel", options.expiresAt ?? NOW + 60 * MINUTE);

  let cliVersion = options.cliVersion === undefined ? "2.1.332 (Claude Code)" : options.cliVersion;
  const cli: ClaudeCli = {
    run: async (args) => {
      calls.push([...args]);

      if (args[0] === "--version") {
        await options.versionGate;

        if (cliVersion === null) {
          throw new ClaudeCliError("exit", "Claude の CLI が失敗しました");
        }

        return cliVersion;
      }

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
    setCliVersion: (value: string | null) => {
      cliVersion = value;
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
  test("有効な token があれば /usage を起こさず、値だけを保存する", async () => {
    const h = harness();
    const endsAt = new Date(NOW + 10 * MINUTE).toISOString();

    stubFetch(() => new Response(cedar([{ resets_left: 2, ends_at: endsAt }]), { status: 200 }));

    await expect(h.service.resetCredits()).resolves.toEqual({ state: "refreshed" });
    expect(h.calls).toEqual([["--version"]]);
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
    expect(h.calls.map((args) => args[0])).toEqual(["--version", "auth", "-p"]);
  });

  test("401 は CLI で更新して 1 回だけやり直し、それでも 401 なら失敗にする", async () => {
    const h = harness();
    const tokens = stubFetch(() => new Response("{}", { status: 401 }));

    saveClaudeResetCredits(h.db, { capturedAt: NOW - MINUTE, credits: { available: 1, expiries: [NOW + 1000] } });

    await expect(h.service.resetCredits()).resolves.toEqual({ state: "failed", error: "reauth_required" });
    expect(tokens).toEqual(["Bearer token-sentinel", "Bearer token-refreshed"]);
    expect(h.calls.map((args) => args[0])).toEqual(["--version", "auth", "-p"]);

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

    const callsAfterRefresh = h.calls.filter((args) => args[0] !== "--version").length;

    // 直後の操作で token が失効していても、cooldown 中は `/usage` を起こさない（版の読み取りは対象外）。
    writeCredential(h.dataDir, "token-expired", NOW - MINUTE);

    await expect(h.service.resetCredits()).resolves.toEqual({ state: "failed", error: "reauth_required" });
    expect(h.calls.filter((args) => args[0] !== "--version")).toHaveLength(callsAfterRefresh);
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

  test("リセット枠は CLI と同じ形の UA に Portal の UA を併記して読む", async () => {
    const h = harness();
    const endsAt = new Date(NOW + 10 * MINUTE).toISOString();
    const seen: (string | null)[] = [];

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(((init?.headers ?? {}) as Record<string, string>)["user-agent"] ?? null);

      return new Response(cedar([{ resets_left: 1, ends_at: endsAt }]), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(h.service.resetCredits()).resolves.toEqual({ state: "refreshed" });
    expect(seen).toEqual(["claude-cli/2.1.332 (external, cli) usage-portal/test"]);
    expect(h.calls).toEqual([["--version"]]);
  });

  test("CLI の版を読めなければ Portal の UA で読み、次の要求で読み直す", async () => {
    const h = harness({ cliVersion: null });
    const seen: (string | null)[] = [];

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(((init?.headers ?? {}) as Record<string, string>)["user-agent"] ?? null);

      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;

    await expect(h.service.resetCredits()).resolves.toEqual({ state: "failed", error: "upstream" });
    await expect(h.service.resetCredits()).resolves.toEqual({ state: "failed", error: "upstream" });
    expect(seen).toEqual(["usage-portal/test", "usage-portal/test"]);
    expect(h.calls).toEqual([["--version"], ["--version"]]);

    // 読めたらその版を使い、以降は CLI を起こさない。
    h.setCliVersion("2.1.332 (Claude Code)");

    await expect(h.service.resetCredits()).resolves.toEqual({ state: "failed", error: "upstream" });
    await expect(h.service.resetCredits()).resolves.toEqual({ state: "failed", error: "upstream" });
    expect(seen.slice(2)).toEqual([
      "claude-cli/2.1.332 (external, cli) usage-portal/test",
      "claude-cli/2.1.332 (external, cli) usage-portal/test",
    ]);
    expect(h.calls).toEqual([["--version"], ["--version"], ["--version"]]);
  });

  test("版の読み取り中にログアウトが終わったら、上流を読まずに中止する", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ versionGate: gate });
    const seen: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));

      return new Response(cedar([{ resets_left: 1, ends_at: new Date(NOW + MINUTE).toISOString() }]), { status: 200 });
    }) as unknown as typeof fetch;

    const reset = h.service.resetCredits();

    await expect(h.service.logout()).resolves.toBe(true);
    release();

    await expect(reset).resolves.toEqual({ state: "skipped", reason: "logout" });
    expect(seen).toEqual([]);
    expect(loadClaudeResetCredits(h.db)).toBeNull();
  });

  test("版を読めたら保持し、2 回目以降は --version を起こさない", async () => {
    const h = harness();
    const endsAt = new Date(NOW + 10 * MINUTE).toISOString();

    stubFetch(() => new Response(cedar([{ resets_left: 1, ends_at: endsAt }]), { status: 200 }));
    await expect(h.service.resetCredits()).resolves.toEqual({ state: "refreshed" });
    await expect(h.service.resetCredits()).resolves.toEqual({ state: "refreshed" });

    // 2 回目以降も版は読み直さない。
    expect(h.calls).toEqual([["--version"]]);
    expect(loadClaudeResetCredits(h.db)?.credits).toEqual({ available: 1, expiries: [Date.parse(endsAt)] });
  });

  test("surface と unavailable の拒否は 0 件にせず、前回の値を残して失敗にする", async () => {
    const h = harness();

    saveClaudeResetCredits(h.db, { capturedAt: NOW - MINUTE, credits: { available: 1, expiries: [NOW + 1000] } });

    for (const reason of ["surface", "unavailable"]) {
      stubFetch(
        () =>
          new Response(JSON.stringify({ cedar_ember: { eligible: false, ineligible_reason: reason, grants: [] } }), {
            status: 200,
          }),
      );

      await expect(h.service.resetCredits()).resolves.toEqual({ state: "failed", error: "upstream" });
    }

    expect(loadClaudeResetCredits(h.db)).toEqual({
      credits: { available: 1, expiries: [NOW + 1000] },
      capturedAt: NOW - MINUTE,
      error: { code: "upstream", message: "Claude からリセット枠を取得できませんでした", at: NOW },
    });
    // 原因は形の変化ではなく拒否だと分かるようにする。
    expect(h.logs).toContain("claude: reset credits upstream (surface)");
    expect(h.logs).toContain("claude: reset credits upstream (unavailable)");
  });

  test("ログアウトでリセット枠も消す", async () => {
    const h = harness();

    saveClaudeResetCredits(h.db, { capturedAt: NOW, credits: { available: 1, expiries: [NOW + 1000] } });

    await expect(h.service.logout()).resolves.toBe(true);
    expect(loadClaudeResetCredits(h.db)).toBeNull();
  });
});
