// Codex の応答を「返ってきた窓だけ」正規化できることを固定する。
import { afterEach, describe, expect, test } from "bun:test";
import {
  CODEX_RESET_CREDITS_URL,
  CODEX_USAGE_URL,
  fetchCodexUsage,
  parseCodexResetCredits,
  parseCodexUsage,
  withResetCreditDetails,
} from "../src/server/providers/codex";
import { ProviderError } from "../src/server/providers/types";

const CAPTURED = 1_800_000_000_000;

function usage(rateLimit: Record<string, unknown>, rest: Record<string, unknown> = {}) {
  return { rate_limit: rateLimit, ...rest };
}

function codeOf(body: unknown): string {
  try {
    parseCodexUsage(body, CAPTURED);

    return "ok";
  } catch (error) {
    return error instanceof ProviderError ? error.code : "unexpected";
  }
}

describe("parseCodexUsage", () => {
  test("primary だけなら 1 窓、5 時間はローリング", () => {
    const snapshot = parseCodexUsage(
      usage({
        primary_window: { used_percent: 12, limit_window_seconds: 5 * 3600, reset_at: 1_800_001_800 },
      }),
      CAPTURED,
    );

    expect(snapshot.provider).toBe("codex");
    expect(snapshot.windows).toEqual([
      {
        id: "primary",
        label: "ローリング",
        durationSeconds: 18_000,
        usedPercent: 12,
        resetsAt: 1_800_001_800_000,
      },
    ]);
  });

  test("primary + secondary は期間から rolling / weekly に振り分ける", () => {
    const snapshot = parseCodexUsage(
      usage({
        primary_window: { used_percent: 40, limit_window_seconds: 18_000 },
        secondary_window: { used_percent: 71, limit_window_seconds: 604_800 },
      }),
      CAPTURED,
    );

    expect(snapshot.windows.map((window) => [window.id, window.label])).toEqual([
      ["primary", "ローリング"],
      ["secondary", "週次"],
    ]);
  });

  test("週次が返らないアカウントでは週次の行を作らない", () => {
    const snapshot = parseCodexUsage(
      usage({ primary_window: { used_percent: 30, limit_window_seconds: 604_800 }, secondary_window: null }),
      CAPTURED,
    );

    expect(snapshot.windows).toHaveLength(1);
    expect(snapshot.windows[0]?.label).toBe("週次");
  });

  test("percent を読めない窓は落とし、0% は残す", () => {
    const snapshot = parseCodexUsage(
      usage({
        primary_window: { used_percent: 0, limit_window_seconds: 18_000 },
        secondary_window: { limit_window_seconds: 604_800 },
      }),
      CAPTURED,
    );

    expect(snapshot.windows.map((window) => [window.id, window.usedPercent])).toEqual([["primary", 0]]);
  });

  test("読める窓が 1 つも無ければ schema エラーにして前回の値を守る", () => {
    expect(codeOf(usage({ primary_window: null, secondary_window: null }))).toBe("schema");
    expect(codeOf({})).toBe("schema");
    expect(codeOf(null)).toBe("schema");
  });

  test("limit_reached と allowed=false のどちらでも上限到達", () => {
    expect(
      parseCodexUsage(usage({ limit_reached: true, primary_window: { used_percent: 10 } }), CAPTURED).limitReached,
    ).toBe(true);
    expect(
      parseCodexUsage(usage({ allowed: false, primary_window: { used_percent: 10 } }), CAPTURED).limitReached,
    ).toBe(true);
    expect(
      parseCodexUsage(usage({ primary_window: { used_percent: 10, allowed: false } }), CAPTURED).limitReached,
    ).toBe(true);
    expect(parseCodexUsage(usage({ primary_window: { used_percent: 10 } }), CAPTURED).limitReached).toBe(false);
  });

  test("クレジット残高は数値で注記し、リセット枠は回数だけを持ち、期限は取得側で足す", () => {
    const withNotes = parseCodexUsage(
      usage(
        { primary_window: { used_percent: 10 } },
        {
          credits: { has_credits: true, balance: "25" },
          rate_limit_reset_credits: { available_count: 2 },
        },
      ),
      CAPTURED,
    );

    expect(withNotes.notes).toEqual(["クレジット残高 25"]);
    expect(withNotes.resetCredits).toEqual({ available: 2, expiries: null });

    const withoutNotes = parseCodexUsage(
      usage(
        { primary_window: { used_percent: 10 } },
        { credits: { has_credits: false, balance: "0" }, rate_limit_reset_credits: { available_count: 0 } },
      ),
      CAPTURED,
    );

    expect(withoutNotes.resetCredits).toBeUndefined();
  });

  test("クレジット残高は 0 と端数も出し、数値を読めなければ有無だけを出す", () => {
    const notesOf = (credits: Record<string, unknown>) =>
      parseCodexUsage(usage({ primary_window: { used_percent: 10 } }, { credits }), CAPTURED).notes;

    expect(notesOf({ has_credits: false, balance: "0" })).toEqual(["クレジット残高 0"]);
    expect(notesOf({ has_credits: true, balance: "12.6" })).toEqual(["クレジット残高 13"]);
    expect(notesOf({ has_credits: true, balance: null })).toEqual(["クレジット残高あり"]);
    expect(notesOf({ has_credits: false, balance: null })).toEqual([]);
    expect(notesOf({ unlimited: true, has_credits: true, balance: "0" })).toEqual(["クレジット無制限"]);
  });

  test("上流が 100 を超えたら 100 に丸めて上限超過を注記する", () => {
    const snapshot = parseCodexUsage(usage({ primary_window: { used_percent: 120 } }), CAPTURED);

    expect(snapshot.windows[0]?.usedPercent).toBe(100);
    expect(snapshot.notes).toContain("上限超過");
  });

  test("reset_at が無ければ reset_after_seconds から取得時刻基準で計算する", () => {
    const snapshot = parseCodexUsage(
      usage({ primary_window: { used_percent: 10, reset_after_seconds: 600 } }),
      CAPTURED,
    );

    expect(snapshot.windows[0]?.resetsAt).toBe(CAPTURED + 10 * 60 * 1000);
    expect(parseCodexUsage(usage({ primary_window: { used_percent: 10 } }), CAPTURED).windows[0]?.resetsAt).toBeNull();
  });

  test("plan は表示用へ写し、未知の値は raw のまま出す", () => {
    expect(parseCodexUsage(usage({ primary_window: { used_percent: 1 } }, { plan_type: "plus" }), CAPTURED).plan).toBe(
      "Plus",
    );
    expect(parseCodexUsage(usage({ primary_window: { used_percent: 1 } }, { plan_type: "pro" }), CAPTURED).plan).toBe(
      "Pro",
    );
    expect(
      parseCodexUsage(usage({ primary_window: { used_percent: 1 } }, { plan_type: "mystery" }), CAPTURED).plan,
    ).toBe("mystery");
    expect(parseCodexUsage(usage({ primary_window: { used_percent: 1 } }), CAPTURED).plan).toBeNull();
  });

  test("limit_window_seconds を読めない窓は rolling に寄せる", () => {
    const snapshot = parseCodexUsage(usage({ primary_window: { used_percent: 10 } }), CAPTURED);

    expect(snapshot.windows[0]?.label).toBe("ローリング");
    expect(snapshot.windows[0]?.durationSeconds).toBeNull();
  });

  test("同じ期間の窓が 2 つなら第1枠 / 第2枠で区別する", () => {
    const snapshot = parseCodexUsage(
      usage({
        primary_window: { used_percent: 10, limit_window_seconds: 18_000 },
        secondary_window: { used_percent: 20, limit_window_seconds: 18_000 },
      }),
      CAPTURED,
    );

    expect(snapshot.windows.map((window) => window.label)).toEqual(["ローリング（第1枠）", "ローリング（第2枠）"]);
  });

  test("additional_rate_limits は v1 の対象外として無視する", () => {
    const snapshot = parseCodexUsage(
      usage({
        primary_window: { used_percent: 10 },
        additional_rate_limits: [{ used_percent: 90 }],
      }),
      CAPTURED,
    );

    expect(snapshot.windows).toHaveLength(1);
  });

  test("取得時刻と User-Agent 以外の上流値を snapshot に持ち込まない", () => {
    const snapshot = parseCodexUsage(
      usage(
        { primary_window: { used_percent: 10, reset_at: 1_800_001_800 } },
        {
          plan_type: "plus",
          email: "sentinel@example.invalid",
          user_id: "user-sentinel",
          account_id: "account-sentinel",
        },
      ),
      CAPTURED,
    );

    const json = JSON.stringify(snapshot);

    expect(json).not.toContain("sentinel");
    expect(snapshot.capturedAt).toBe(CAPTURED);
  });
});

describe("parseCodexResetCredits", () => {
  test("available な枠の期限だけを昇順で返す", () => {
    const expiries = parseCodexResetCredits({
      credits: [
        { status: "available", expires_at: "2026-12-26T05:05:40.952825Z" },
        { status: "redeemed", expires_at: "2026-01-01T00:00:00Z" },
        { status: "available", expires_at: "2026-12-12T22:36:59.170831Z" },
      ],
      available_count: 2,
    });

    expect(expiries).toEqual([Date.parse("2026-12-12T22:36:59.170831Z"), Date.parse("2026-12-26T05:05:40.952825Z")]);
  });

  test("期限の無い枠と日時を読めない枠は期限に数えない", () => {
    expect(
      parseCodexResetCredits({
        credits: [
          { status: "available", expires_at: null },
          { status: "available", expires_at: "not-a-date" },
          { status: "available" },
        ],
      }),
    ).toEqual([]);
  });

  test("credits が配列でない応答は「期限不明」として null", () => {
    expect(parseCodexResetCredits({})).toBeNull();
    expect(parseCodexResetCredits({ credits: null })).toBeNull();
    expect(parseCodexResetCredits(null)).toBeNull();
  });
});

describe("withResetCreditDetails", () => {
  const snapshot = parseCodexUsage(
    usage({ primary_window: { used_percent: 10 } }, { rate_limit_reset_credits: { available_count: 2 } }),
    CAPTURED,
  );

  test("available な枠の期限を全部、昇順で足す", () => {
    const merged = withResetCreditDetails(snapshot, {
      credits: [
        { status: "available", expires_at: "2026-12-26T05:05:40Z" },
        { status: "available", expires_at: "2026-12-12T22:36:59Z" },
      ],
    });

    expect(merged.resetCredits).toEqual({
      available: 2,
      expiries: [Date.parse("2026-12-12T22:36:59Z"), Date.parse("2026-12-26T05:05:40Z")],
    });
  });

  test("期限の無い枠しか無ければ空の期限一覧にする", () => {
    const merged = withResetCreditDetails(snapshot, { credits: [{ status: "available", expires_at: null }] });

    expect(merged.resetCredits).toEqual({ available: 2, expiries: [] });
  });

  test("詳細を読めない応答は usage の回数だけを残す", () => {
    expect(withResetCreditDetails(snapshot, {})).toBe(snapshot);
    expect(withResetCreditDetails(snapshot, null)).toBe(snapshot);
  });

  test("リセット枠を持たない snapshot はそのまま返す", () => {
    const plain = parseCodexUsage(usage({ primary_window: { used_percent: 10 } }), CAPTURED);

    expect(withResetCreditDetails(plain, { credits: [] })).toBe(plain);
  });
});

describe("fetchCodexUsage", () => {
  const realFetch = globalThis.fetch;
  const source = {
    credential: async () => ({ accessToken: "token-sentinel", accountId: "account-sentinel" }),
  };

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  function usageResponse(available: number): Response {
    return jsonResponse(
      usage({ primary_window: { used_percent: 10 } }, { rate_limit_reset_credits: { available_count: available } }),
    );
  }

  test("リセット枠があるときだけ詳細を読み、期限を全部入れる", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);

      return url === CODEX_RESET_CREDITS_URL
        ? jsonResponse({
            credits: [
              { status: "available", expires_at: "2026-12-26T05:05:40.952825Z" },
              { status: "available", expires_at: "2026-12-12T22:36:59.170831Z" },
            ],
          })
        : usageResponse(2);
    }) as unknown as typeof fetch;

    const snapshot = await fetchCodexUsage({ source, userAgent: "usage-portal/test", now: () => CAPTURED });

    expect(urls).toEqual([CODEX_USAGE_URL, CODEX_RESET_CREDITS_URL]);
    expect(snapshot.resetCredits).toEqual({
      available: 2,
      expiries: [Date.parse("2026-12-12T22:36:59.170831Z"), Date.parse("2026-12-26T05:05:40.952825Z")],
    });
    expect(JSON.stringify(snapshot)).not.toContain("sentinel");
  });

  test("リセット枠が 0 なら詳細を問い合わせない", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));

      return usageResponse(0);
    }) as unknown as typeof fetch;

    const snapshot = await fetchCodexUsage({ source, userAgent: "usage-portal/test", now: () => CAPTURED });

    expect(urls).toEqual([CODEX_USAGE_URL]);
    expect(snapshot.resetCredits).toBeUndefined();
  });

  test("詳細が失敗しても usage の回数だけで snapshot を返す", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      String(input) === CODEX_RESET_CREDITS_URL ? jsonResponse({}, 500) : usageResponse(2)) as unknown as typeof fetch;

    const snapshot = await fetchCodexUsage({ source, userAgent: "usage-portal/test", now: () => CAPTURED });

    expect(snapshot.windows).toHaveLength(1);
    expect(snapshot.resetCredits).toEqual({ available: 2, expiries: null });
  });
});
