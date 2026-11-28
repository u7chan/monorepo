// Claude の更新応答・ログアウト・カードを出す判定と、provider: claude の source を画面側で解釈できることを固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { logoutClaude, parseClaudeRefresh, parseClaudeResetCreditsOutcome, parseUsage } from "../src/client/api";
import {
  claudeRefreshMessage,
  claudeResetCreditsMessage,
  claudeStatusLabel,
  showsClaudeCard,
} from "../src/client/lib/claude";

describe("parseClaudeRefresh", () => {
  test("refreshed / skipped の理由 / failed のコードだけを受け取る", () => {
    expect(parseClaudeRefresh({ state: "refreshed" })).toEqual({ state: "refreshed" });
    expect(parseClaudeRefresh({ state: "skipped", reason: "fresh" })).toEqual({ state: "skipped", reason: "fresh" });
    expect(parseClaudeRefresh({ state: "skipped", reason: "cooldown" })).toEqual({
      state: "skipped",
      reason: "cooldown",
    });
    expect(parseClaudeRefresh({ state: "skipped", reason: "logout" })).toEqual({
      state: "skipped",
      reason: "logout",
    });
    expect(parseClaudeRefresh({ state: "failed", error: "not_connected" })).toEqual({
      state: "failed",
      error: "not_connected",
    });
  });

  test("知らない状態・理由は捨て、コードの無い失敗は unavailable にする", () => {
    expect(parseClaudeRefresh({ state: "skipped", reason: "later" })).toBeNull();
    expect(parseClaudeRefresh({ state: "unknown" })).toBeNull();
    expect(parseClaudeRefresh(null)).toBeNull();
    expect(parseClaudeRefresh({ state: "failed" })).toEqual({ state: "failed", error: "unavailable" });
  });
});

describe("showsClaudeCard", () => {
  test("取得前と未接続はカードを出さない", () => {
    expect(showsClaudeCard({ capturedAt: null, error: null })).toBe(false);
    expect(showsClaudeCard({ capturedAt: null, error: { code: "not_connected" } })).toBe(false);
    // snapshot と未接続の error が同時に残っていても、未接続を優先する。
    expect(showsClaudeCard({ capturedAt: 1, error: { code: "not_connected" } })).toBe(false);
  });

  test("取得済みと、利用者が対処できる取得エラーはカードを出す", () => {
    expect(showsClaudeCard({ capturedAt: 1, error: null })).toBe(true);

    for (const code of ["reauth_required", "subscription_required", "upstream", "schema", "config"]) {
      expect(showsClaudeCard({ capturedAt: null, error: { code } })).toBe(true);
    }
  });
});

describe("claudeStatusLabel", () => {
  test("未接続と取得エラーを、次にすることの分かる文言にする", () => {
    expect(claudeStatusLabel({ capturedAt: null, error: null })).toBe("確認していません");
    expect(claudeStatusLabel({ capturedAt: null, error: { code: "not_connected" } })).toBe("未接続");
    expect(claudeStatusLabel({ capturedAt: null, error: { code: "subscription_required" } })).toContain("Pro / Max");
    expect(claudeStatusLabel({ capturedAt: null, error: { code: "upstream" } })).toContain("取得できません");
    expect(claudeStatusLabel({ capturedAt: 1, error: null })).toBe("取得済み");
  });
});

describe("claudeRefreshMessage", () => {
  test("4 つの結果と通信失敗を固定文言にする", () => {
    expect(claudeRefreshMessage(null)).toContain("通信に失敗");
    expect(claudeRefreshMessage({ state: "refreshed" })).toContain("更新しました");
    expect(claudeRefreshMessage({ state: "skipped", reason: "fresh" })).toContain("15 分以内");
    expect(claudeRefreshMessage({ state: "skipped", reason: "cooldown" })).toContain("60 秒");
    expect(claudeRefreshMessage({ state: "skipped", reason: "logout" })).toContain("ログアウト");
    expect(claudeRefreshMessage({ state: "failed", error: "upstream" })).toContain("失敗");
  });
});

describe("logoutClaude", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("204 を成功、503 を失敗として真偽で返す", async () => {
    const seen: { method: string | null } = { method: null };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.method = init?.method ?? null;
      expect(String(input)).toBe("/api/claude/logout");

      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    expect(await logoutClaude()).toBe(true);
    expect(seen.method).toBe("POST");

    globalThis.fetch = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;

    expect(await logoutClaude()).toBe(false);
  });
});

describe("parseUsage", () => {
  test("provider: claude の source を読み、次回取得が無くても落とさない", () => {
    const payload = parseUsage({
      generatedAt: 1,
      sources: [
        {
          id: "claude",
          provider: "claude",
          name: "Claude",
          plan: "Max",
          account: null,
          state: "ok",
          capturedAt: 1,
          fetchIntervalMs: 900_000,
          nextFetchAt: null,
          error: null,
          limitReached: false,
          windows: [{ id: "rolling", label: "ローリング", durationSeconds: 18_000, usedPercent: 12, resetsAt: null }],
          notes: [],
          claudeResetCredits: null,
          trends: [],
        },
      ],
    });

    expect(payload?.sources).toHaveLength(1);
    expect(payload?.sources[0]?.provider).toBe("claude");
    expect(payload?.sources[0]?.plan).toBe("Max");
    expect(payload?.sources[0]?.nextFetchAt).toBeNull();
    expect(payload?.sources[0]?.resetCredits).toBeNull();
  });
});

describe("parseClaudeResetCreditsOutcome", () => {
  test("refreshed / skipped / failed だけを受け取る", () => {
    expect(parseClaudeResetCreditsOutcome({ state: "refreshed" })).toEqual({ state: "refreshed" });
    expect(parseClaudeResetCreditsOutcome({ state: "skipped", reason: "logout" })).toEqual({
      state: "skipped",
      reason: "logout",
    });
    expect(parseClaudeResetCreditsOutcome({ state: "failed", error: "schema" })).toEqual({
      state: "failed",
      error: "schema",
    });
    expect(parseClaudeResetCreditsOutcome({ state: "failed" })).toEqual({ state: "failed", error: "unavailable" });
    expect(parseClaudeResetCreditsOutcome({ state: "skipped", reason: "fresh" })).toBeNull();
    expect(parseClaudeResetCreditsOutcome(null)).toBeNull();
  });

  test("文言は状態ごとに分け、上流の本文を出さない", () => {
    expect(claudeResetCreditsMessage({ state: "refreshed" })).toBe("リセット枠を取得しました。");
    expect(claudeResetCreditsMessage({ state: "failed", error: "reauth_required" })).toContain("サインイン");
    expect(claudeResetCreditsMessage({ state: "failed", error: "upstream" })).not.toContain("HTTP");
    expect(claudeResetCreditsMessage(null)).toContain("通信");
  });
});
