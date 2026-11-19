// Claude の /usage と auth status の正規化を、公式 CLI 2.1.327 の出力を写した fixture で固定する。
import { describe, expect, test } from "bun:test";
import {
  CLAUDE_AUTH_ARGS,
  CLAUDE_USAGE_ARGS,
  parseClaudeResetDate,
  parseClaudeUsage,
  readClaudeAuth,
  claudeAuthError,
  fetchClaudeUsage,
} from "../src/server/providers/claude";
import { ClaudeCliError, type ClaudeCli } from "../src/server/claude/cli";
import { ProviderError } from "../src/server/providers/types";

const NOW = Date.UTC(2026, 10, 18, 22, 0);
const PST = "America/Los_Angeles";

const USAGE_TEXT = [
  "You are currently using your subscription to power your Claude Code usage",
  "",
  "Current session: 12% used · resets Nov 19, 12:50am (America/Los_Angeles)",
  "Current week (all models): 45% used · resets Nov 25, 6am (America/Los_Angeles)",
].join("\n");

function providerError(fn: () => unknown): ProviderError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProviderError) {
      return error;
    }

    throw error;
  }

  throw new Error("ProviderError が投げられませんでした");
}

describe("parseClaudeUsage", () => {
  test("Current session をローリング、Current week (all models) を週次にし、TZ の日時を読む", () => {
    const snapshot = parseClaudeUsage(USAGE_TEXT, { capturedAt: NOW, plan: "Max" });

    expect(snapshot.provider).toBe("claude");
    expect(snapshot.name).toBe("Claude");
    expect(snapshot.plan).toBe("Max");
    expect(snapshot.capturedAt).toBe(NOW);
    expect(snapshot.limitReached).toBe(false);
    expect(snapshot.windows).toEqual([
      {
        id: "rolling",
        label: "ローリング",
        durationSeconds: 18_000,
        usedPercent: 12,
        // 11 月のロサンゼルスは UTC-8。
        resetsAt: Date.UTC(2026, 10, 19, 8, 50),
      },
      {
        id: "weekly",
        label: "週次",
        durationSeconds: 604_800,
        usedPercent: 45,
        resetsAt: Date.UTC(2026, 10, 25, 14, 0),
      },
    ]);
    expect(snapshot.notes).toEqual([]);
  });

  test("年が付いた日時はその年を使い、区切りは at でも読む", () => {
    const snapshot = parseClaudeUsage("Current week (all models): 80% used · resets Jan 2, 2027 at 3am (UTC)", {
      capturedAt: Date.UTC(2026, 11, 30),
      plan: null,
    });

    expect(snapshot.windows).toHaveLength(1);
    expect(snapshot.windows[0]?.resetsAt).toBe(Date.UTC(2027, 0, 2, 3, 0));
  });

  test("年が無い日時は今より後で最も近い日時を採る（年末の週次）", () => {
    const snapshot = parseClaudeUsage("Current week (all models): 50% used · resets Jan 2, 3am (UTC)", {
      capturedAt: Date.UTC(2026, 11, 29),
      plan: null,
    });

    expect(snapshot.windows[0]?.resetsAt).toBe(Date.UTC(2027, 0, 2, 3, 0));
  });

  test("モデル別の週次は読まない（Max / Team の出力）", () => {
    const snapshot = parseClaudeUsage(
      [
        "Current week (all models): 45% used · resets Nov 25, 6am (UTC)",
        "Current week (Sonnet only): 90% used · resets Nov 25, 6am (UTC)",
        "Current week (Opus): 30% used · resets Nov 25, 6am (UTC)",
      ].join("\n"),
      { capturedAt: NOW, plan: "Max" },
    );

    expect(snapshot.windows.map((window) => [window.id, window.usedPercent])).toEqual([["weekly", 45]]);
  });

  test("リセット行が無い窓は残し、resetsAt を null にする", () => {
    const snapshot = parseClaudeUsage("Current session: 3% used", { capturedAt: NOW, plan: null });

    expect(snapshot.windows).toEqual([
      { id: "rolling", label: "ローリング", durationSeconds: 18_000, usedPercent: 3, resetsAt: null },
    ]);
  });

  test("タイムゾーンを解釈できなければ、その窓のリセットだけを落とす", () => {
    const snapshot = parseClaudeUsage("Current session: 7% used · resets Nov 19, 12:50am (Not/AZone)", {
      capturedAt: NOW,
      plan: null,
    });

    expect(snapshot.windows[0]?.usedPercent).toBe(7);
    expect(snapshot.windows[0]?.resetsAt).toBeNull();
  });

  test("100% を超えた出力は 100 に clamp し、上限超過を note と limitReached に残す", () => {
    const snapshot = parseClaudeUsage("Current session: 137% used · resets Nov 19, 12:50am (UTC)", {
      capturedAt: NOW,
      plan: null,
    });

    expect(snapshot.windows[0]?.usedPercent).toBe(100);
    expect(snapshot.limitReached).toBe(true);
    expect(snapshot.notes).toEqual(["上限超過"]);
  });

  test("認識できる行が 1 つも無ければ schema エラー", () => {
    const error = providerError(() =>
      parseClaudeUsage("You are currently using your subscription to power your Claude Code usage", {
        capturedAt: NOW,
        plan: null,
      }),
    );

    expect(error.code).toBe("schema");
  });
});

describe("parseClaudeResetDate", () => {
  test("分が 0 なら時刻だけ、分があれば時分で読む", () => {
    expect(parseClaudeResetDate("Nov 25, 6am", PST, NOW)).toBe(Date.UTC(2026, 10, 25, 14, 0));
    expect(parseClaudeResetDate("Nov 19, 12:50am", PST, NOW)).toBe(Date.UTC(2026, 10, 19, 8, 50));
  });

  test("12am は 0 時、12pm は 12 時として読む", () => {
    expect(parseClaudeResetDate("Dec 1, 12am", "UTC", NOW)).toBe(Date.UTC(2026, 11, 1, 0, 0));
    expect(parseClaudeResetDate("Dec 1, 12pm", "UTC", NOW)).toBe(Date.UTC(2026, 11, 1, 12, 0));
  });

  test("読めない日時は null", () => {
    expect(parseClaudeResetDate("soon", "UTC", NOW)).toBeNull();
    expect(parseClaudeResetDate("Feb 30, 3am", "UTC", NOW)).toBeNull();
    expect(parseClaudeResetDate("Nov 19, 12:50am", "Not/AZone", NOW)).toBeNull();
  });
});

describe("readClaudeAuth", () => {
  test("claude.ai のサインインだけを接続済みとし、plan は subscriptionType にする", () => {
    const auth = readClaudeAuth(
      {
        loggedIn: true,
        authMethod: "claude.ai",
        subscriptionType: "max",
        loginExpiresAt: "2027-01-01T00:00:00.000Z",
        email: "sentinel@example.invalid",
        orgName: "sentinel-org",
      },
      NOW,
    );

    expect(auth).toEqual({ status: "connected", plan: "Max" });
  });

  test("未ログイン・API キー・期限切れを分ける", () => {
    expect(readClaudeAuth({ loggedIn: false, authMethod: "none" }, NOW)).toEqual({
      status: "not_connected",
      plan: null,
    });
    expect(readClaudeAuth({ loggedIn: true, authMethod: "api_key" }, NOW)).toEqual({
      status: "subscription_required",
      plan: null,
    });
    expect(
      readClaudeAuth(
        { loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro", loginExpiresAt: NOW - 1 },
        NOW,
      ),
    ).toEqual({ status: "reauth_required", plan: "Pro" });
  });

  test("期限を読めなければ再サインインを促さない", () => {
    expect(readClaudeAuth({ loggedIn: true, authMethod: "claude.ai", loginExpiresAt: null }, NOW)).toEqual({
      status: "connected",
      plan: null,
    });
    expect(readClaudeAuth({ loggedIn: true, authMethod: "claude.ai", loginExpiresAt: "garbage" }, NOW)).toEqual({
      status: "connected",
      plan: null,
    });
  });

  test("loggedIn が無い出力は解釈できない", () => {
    expect(readClaudeAuth({ authMethod: "claude.ai" }, NOW)).toBeNull();
    expect(readClaudeAuth(null, NOW)).toBeNull();
  });

  test("止める理由を固定のエラーコードへ振る", () => {
    expect(claudeAuthError({ status: "not_connected", plan: null })?.code).toBe("not_connected");
    expect(claudeAuthError({ status: "subscription_required", plan: null })?.code).toBe("subscription_required");
    expect(claudeAuthError({ status: "reauth_required", plan: null })?.code).toBe("reauth_required");
    expect(claudeAuthError({ status: "connected", plan: null })).toBeNull();
  });
});

describe("fetchClaudeUsage", () => {
  function cliWith(results: readonly string[], calls: string[][] = []): ClaudeCli {
    return {
      run: async (args) => {
        calls.push([...args]);

        return results[Math.min(calls.length - 1, results.length - 1)] ?? "";
      },
    };
  }

  test("接続を確かめてから /usage を起動し、auth status の JSON だけを読む", async () => {
    const calls: string[][] = [];
    const snapshot = await fetchClaudeUsage({
      now: () => NOW,
      cli: cliWith(
        [
          JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
          JSON.stringify({ result: USAGE_TEXT }),
        ],
        calls,
      ),
    });

    expect(calls).toEqual([[...CLAUDE_AUTH_ARGS], [...CLAUDE_USAGE_ARGS]]);
    expect(snapshot.plan).toBe("Max");
    expect(snapshot.windows).toHaveLength(2);
  });

  test("接続できないときは /usage を起動しない", async () => {
    const calls: string[][] = [];
    const cli = cliWith([JSON.stringify({ loggedIn: false, authMethod: "none" })], calls);

    await expect(fetchClaudeUsage({ now: () => NOW, cli })).rejects.toMatchObject({ code: "not_connected" });
    expect(calls).toHaveLength(1);
  });

  test("CLI の起動失敗・出力の解釈失敗は固定のコードにする", async () => {
    const missing: ClaudeCli = {
      run: async () => {
        throw new ClaudeCliError("spawn", "spawn failed: sentinel");
      },
    };
    const invalid: ClaudeCli = {
      run: async () => "not json: sentinel",
    };

    await expect(fetchClaudeUsage({ now: () => NOW, cli: missing })).rejects.toMatchObject({ code: "config" });
    await expect(fetchClaudeUsage({ now: () => NOW, cli: invalid })).rejects.toMatchObject({ code: "schema" });
  });
});
