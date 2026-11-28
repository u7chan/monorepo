// Claude のリセット枠（手動取得）の正規化・資格情報の読み取り・上流の分類を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_RESET_CREDITS_URL,
  claudeResetCreditsRejection,
  claudeResetCreditsUserAgent,
  parseClaudeResetCredits,
  readClaudeAccessToken,
  requestClaudeResetCredits,
} from "../src/server/claude/reset-credits";

const NOW = 1_800_000_000_000;
const MINUTE = 60 * 1000;
const dirs: string[] = [];

function credentialDir(token: string | null, expiresAt = NOW + 60 * MINUTE): string {
  const dir = mkdtempSync(join(tmpdir(), "usage-portal-claude-reset-"));

  dirs.push(dir);
  mkdirSync(join(dir, "claude"), { recursive: true });

  if (token !== null) {
    writeFileSync(
      join(dir, "claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt } }),
    );
  }

  return dir;
}

function cedar(grants: unknown[] | null): unknown {
  return { cedar_ember: grants === null ? null : { eligible: true, grants } };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("readClaudeAccessToken", () => {
  test("有効な token を読み、期限切れと未保存は null にする", () => {
    expect(readClaudeAccessToken(credentialDir("token-sentinel"), NOW)).toBe("token-sentinel");
    expect(readClaudeAccessToken(credentialDir("token-sentinel", NOW - MINUTE), NOW)).toBeNull();
    expect(readClaudeAccessToken(credentialDir(null), NOW)).toBeNull();
    expect(readClaudeAccessToken(join(tmpdir(), "usage-portal-no-such-dir"), NOW)).toBeNull();
  });
});

describe("parseClaudeResetCredits", () => {
  test("残っている grant の回数を合計し、期限を昇順で返す", () => {
    const credits = parseClaudeResetCredits(
      cedar([
        { resets_left: 1, ends_at: new Date(NOW + 10 * MINUTE).toISOString() },
        { resets_left: 2, ends_at: new Date(NOW + 5 * MINUTE).toISOString() },
      ]),
      NOW,
    );

    expect(credits).toEqual({
      available: 3,
      expiries: [NOW + 5 * MINUTE, NOW + 10 * MINUTE],
    });
  });

  test("0 回・期限切れ・期限なしの grant は数えない（形は読めている）", () => {
    const credits = parseClaudeResetCredits(
      cedar([
        { resets_left: 0, ends_at: new Date(NOW + 10 * MINUTE).toISOString() },
        { resets_left: 1, ends_at: new Date(NOW - MINUTE).toISOString() },
        { resets_left: 1, ends_at: null },
      ]),
      NOW,
    );

    expect(credits).toEqual({ available: 0, expiries: [] });
  });

  test("grant の形が読めなければ、0 件ではなく取得失敗にする", () => {
    const valid = { resets_left: 1, ends_at: new Date(NOW + 10 * MINUTE).toISOString() };

    expect(parseClaudeResetCredits(cedar([{ ...valid, resets_left: "1" }]), NOW)).toBeNull();
    expect(parseClaudeResetCredits(cedar([{ ...valid, resets_left: 1.5 }]), NOW)).toBeNull();
    expect(parseClaudeResetCredits(cedar([{ ...valid, resets_left: -1 }]), NOW)).toBeNull();
    expect(parseClaudeResetCredits(cedar([{ ...valid, ends_at: 123 }]), NOW)).toBeNull();
    expect(parseClaudeResetCredits(cedar([{ resets_left: 1 }]), NOW)).toBeNull();
    expect(parseClaudeResetCredits(cedar([{ ...valid, ends_at: "not-a-date" }]), NOW)).toBeNull();
    expect(parseClaudeResetCredits(cedar([{ ends_at: valid.ends_at }]), NOW)).toBeNull();
    expect(parseClaudeResetCredits(cedar(["not-an-object"]), NOW)).toBeNull();
  });

  test("0 件は grant が無いと分かる理由と grants の欠落だけにする", () => {
    for (const reason of ["config_off", "tier", "seat", "no_grant", "tenure", "other_experiment"]) {
      expect(parseClaudeResetCredits({ cedar_ember: { eligible: false, ineligible_reason: reason } }, NOW)).toEqual({
        available: 0,
        expiries: [],
      });
    }

    expect(parseClaudeResetCredits({ cedar_ember: { eligible: true, grants: undefined } }, NOW)).toEqual({
      available: 0,
      expiries: [],
    });
    expect(parseClaudeResetCredits(cedar(null), NOW)).toBeNull();
    expect(parseClaudeResetCredits({}, NOW)).toBeNull();
    expect(parseClaudeResetCredits({ cedar_ember: { grants: [] } }, NOW)).toBeNull();
    expect(parseClaudeResetCredits({ cedar_ember: { eligible: true, grants: {} } }, NOW)).toBeNull();
    expect(parseClaudeResetCredits(null, NOW)).toBeNull();
  });

  test("grant が無いと言い切れない理由は、0 件ではなく取得失敗にする", () => {
    for (const reason of ["surface", "cli_version", "mobile", "unavailable", "unknown", "client"]) {
      expect(
        parseClaudeResetCredits({ cedar_ember: { eligible: false, ineligible_reason: reason, grants: [] } }, NOW),
      ).toBeNull();
    }

    // 理由の欠落も形の変化として扱う。
    expect(parseClaudeResetCredits({ cedar_ember: { eligible: false, grants: [] } }, NOW)).toBeNull();
  });
});

describe("claudeResetCreditsRejection", () => {
  test("拒否・判定不能の理由だけを固定の語彙で返す", () => {
    expect(claudeResetCreditsRejection({ cedar_ember: { eligible: false, ineligible_reason: "surface" } })).toBe(
      "surface",
    );
    expect(claudeResetCreditsRejection({ cedar_ember: { eligible: false, ineligible_reason: "cli_version" } })).toBe(
      "cli_version",
    );
    expect(claudeResetCreditsRejection({ cedar_ember: { eligible: false, ineligible_reason: "mobile" } })).toBe(
      "mobile",
    );
    expect(claudeResetCreditsRejection({ cedar_ember: { eligible: false, ineligible_reason: "unavailable" } })).toBe(
      "unavailable",
    );
    expect(claudeResetCreditsRejection({ cedar_ember: { eligible: false, ineligible_reason: "client" } })).toBe(
      "unknown",
    );
    expect(claudeResetCreditsRejection({ cedar_ember: { eligible: false } })).toBe("unknown");
  });

  test("grant が無いだけの理由と、eligible: true は拒否にしない", () => {
    for (const reason of ["config_off", "tier", "seat", "no_grant", "tenure", "other_experiment"]) {
      expect(claudeResetCreditsRejection({ cedar_ember: { eligible: false, ineligible_reason: reason } })).toBeNull();
    }

    expect(claudeResetCreditsRejection({ cedar_ember: { eligible: true, grants: [] } })).toBeNull();
    expect(claudeResetCreditsRejection({})).toBeNull();
    expect(claudeResetCreditsRejection(null)).toBeNull();
  });
});

describe("claudeResetCreditsUserAgent", () => {
  test("CLI と同じ形にして Portal の UA を併記する", () => {
    expect(claudeResetCreditsUserAgent("2.1.332", "usage-portal/0.1.0")).toBe(
      "claude-cli/2.1.332 (external, cli) usage-portal/0.1.0",
    );
  });
});

describe("requestClaudeResetCredits", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubFetch(respond: (url: string, headers: Record<string, string>) => Response): string[] {
    const seen: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);

      return respond(url, (init?.headers ?? {}) as Record<string, string>);
    }) as unknown as typeof fetch;

    return seen;
  }

  test("token が無ければ上流へ出ず needs_credential", async () => {
    const seen = stubFetch(() => new Response("{}", { status: 200 }));

    const result = await requestClaudeResetCredits({
      credentialDir: credentialDir(null),
      userAgent: "usage-portal/test",
      now: () => NOW,
    });

    expect(result).toEqual({ kind: "needs_credential" });
    expect(seen).toEqual([]);
  });

  test("OAuth の beta と Bearer を付けて読み、残数を返す", async () => {
    const expiresAt = new Date(NOW + 10 * MINUTE).toISOString();
    const seen = stubFetch((_url, headers) => {
      expect(headers.authorization).toBe("Bearer token-sentinel");
      expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");

      return new Response(JSON.stringify(cedar([{ resets_left: 2, ends_at: expiresAt }])), { status: 200 });
    });

    const result = await requestClaudeResetCredits({
      credentialDir: credentialDir("token-sentinel"),
      userAgent: "usage-portal/test",
      now: () => NOW,
    });

    expect(seen).toEqual([CLAUDE_RESET_CREDITS_URL]);
    expect(result).toEqual({ kind: "ok", credits: { available: 2, expiries: [Date.parse(expiresAt)] } });
  });

  test("401 は unauthorized、500 は upstream、形が違えば schema", async () => {
    async function readWith(status: number, body: string): Promise<string> {
      stubFetch(() => new Response(body, { status }));

      const result = await requestClaudeResetCredits({
        credentialDir: credentialDir("token-sentinel"),
        userAgent: "usage-portal/test",
        now: () => NOW,
      });

      return result.kind;
    }

    expect(await readWith(401, "{}")).toBe("unauthorized");
    expect(await readWith(403, "{}")).toBe("unauthorized");
    expect(await readWith(500, "{}")).toBe("upstream");
    expect(await readWith(200, "{}")).toBe("schema");
  });

  test("拒否の理由は rejected として返し、そのまま成功にしない", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ cedar_ember: { eligible: false, ineligible_reason: "surface" } }), {
          status: 200,
        }),
    );

    const result = await requestClaudeResetCredits({
      credentialDir: credentialDir("token-sentinel"),
      userAgent: "usage-portal/test",
      now: () => NOW,
    });

    expect(result).toEqual({ kind: "rejected", rejection: "surface" });
  });
});
