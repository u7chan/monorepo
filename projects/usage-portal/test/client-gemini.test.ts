// Gemini の更新・ログアウトの応答、カードを出す判定、文言と、provider: gemini の source を画面側で解釈できることを固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { logoutGemini, parseUsage, refreshGeminiUsage } from "../src/client/api";
import {
  GEMINI_LOGIN_COMMAND,
  GEMINI_SCOPE_NOTE,
  geminiLogoutMessage,
  geminiRefreshMessage,
  geminiStatusLabel,
  showsGeminiCard,
} from "../src/client/lib/gemini";
import { isOnDemandProvider } from "../src/shared/on-demand";

describe("showsGeminiCard", () => {
  test("取得前と未接続はカードを出さない", () => {
    expect(showsGeminiCard({ capturedAt: null, error: null })).toBe(false);
    expect(showsGeminiCard({ capturedAt: null, error: { code: "not_connected" } })).toBe(false);
    // snapshot と未接続の error が同時に残っていても、未接続を優先する。
    expect(showsGeminiCard({ capturedAt: 1, error: { code: "not_connected" } })).toBe(false);
  });

  test("取得済みと、取得エラーはカードを出す（ログアウトの入口を残すため）", () => {
    expect(showsGeminiCard({ capturedAt: 1, error: null })).toBe(true);

    for (const code of ["upstream", "schema", "config"]) {
      expect(showsGeminiCard({ capturedAt: null, error: { code } })).toBe(true);
      expect(showsGeminiCard({ capturedAt: 1, error: { code } })).toBe(true);
    }
  });
});

describe("geminiStatusLabel", () => {
  test("未接続と取得エラーを、次にすることの分かる文言にする", () => {
    expect(geminiStatusLabel({ capturedAt: null, error: null })).toBe("確認していません");
    expect(geminiStatusLabel({ capturedAt: 1, error: null })).toBe("取得済み");
    expect(geminiStatusLabel({ capturedAt: null, error: { code: "not_connected" } })).toBe("未接続");
    expect(geminiStatusLabel({ capturedAt: null, error: { code: "config" } })).toContain("CLI");
    expect(geminiStatusLabel({ capturedAt: null, error: { code: "schema" } })).toContain("解釈");
    expect(geminiStatusLabel({ capturedAt: null, error: { code: "upstream" } })).toContain("取得できません");
  });
});

describe("geminiRefreshMessage", () => {
  test("4 つの結果と通信失敗を固定文言にする", () => {
    expect(geminiRefreshMessage(null)).toContain("通信に失敗");
    expect(geminiRefreshMessage({ state: "refreshed" })).toContain("更新しました");
    expect(geminiRefreshMessage({ state: "skipped", reason: "fresh" })).toContain("15 分以内");
    expect(geminiRefreshMessage({ state: "skipped", reason: "cooldown" })).toContain("60 秒");
    expect(geminiRefreshMessage({ state: "skipped", reason: "logout" })).toContain("ログアウト");
    expect(geminiRefreshMessage({ state: "failed", error: "upstream" })).toContain("失敗");
  });
});

describe("geminiLogoutMessage", () => {
  test("接続が残ったときと、確認できなかったときで文言を分ける", () => {
    expect(geminiLogoutMessage("incomplete")).toContain("まだ接続済み");
    expect(geminiLogoutMessage("failed")).toContain("ログアウトできませんでした");
    expect(geminiLogoutMessage(null)).toContain("ログアウトできませんでした");
  });
});

describe("固定の文言", () => {
  test("サインインの手順は agy を、アプリが使う HOME で起動する", () => {
    expect(GEMINI_LOGIN_COMMAND).toBe("docker exec -it -e HOME=/app/credentials/antigravity <コンテナ名> agy");
  });

  test("取れる枠の範囲を示し、プラン名を断定しない", () => {
    expect(GEMINI_SCOPE_NOTE).toContain("Antigravity");
    expect(GEMINI_SCOPE_NOTE).toContain("Gemini アプリ");
    expect(GEMINI_SCOPE_NOTE).not.toMatch(/Pro|Ultra|Plus|無料|Free/);
  });
});

describe("isOnDemandProvider", () => {
  test("周期取得の無い provider は claude と gemini だけ", () => {
    expect(isOnDemandProvider("claude")).toBe(true);
    expect(isOnDemandProvider("gemini")).toBe(true);
    expect(isOnDemandProvider("codex")).toBe(false);
    expect(isOnDemandProvider("opencode-go")).toBe(false);
  });
});

describe("api", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubFetch(response: Response, seen: { url?: string; init?: RequestInit } = {}): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.url = String(input);
      seen.init = init;

      return response;
    }) as unknown as typeof fetch;
  }

  test("logoutGemini は 204 を done、409 を incomplete、それ以外を failed にする", async () => {
    const seen: { url?: string; init?: RequestInit } = {};

    stubFetch(new Response(null, { status: 204 }), seen);

    expect(await logoutGemini()).toBe("done");
    expect(seen.url).toBe("/api/gemini/logout");
    expect(seen.init?.method).toBe("POST");

    stubFetch(new Response('{"error":"logout_incomplete"}', { status: 409 }));
    expect(await logoutGemini()).toBe("incomplete");

    for (const status of [401, 403, 503]) {
      stubFetch(new Response("{}", { status }));
      expect(await logoutGemini()).toBe("failed");
    }
  });

  test("refreshGeminiUsage は mode を POST し、応答を Claude と同じ形で解釈する", async () => {
    const seen: { url?: string; init?: RequestInit } = {};

    stubFetch(Response.json({ state: "skipped", reason: "cooldown" }), seen);

    expect(await refreshGeminiUsage("manual")).toEqual({ state: "skipped", reason: "cooldown" });
    expect(seen.url).toBe("/api/gemini/refresh");
    expect(seen.init?.method).toBe("POST");
    expect(seen.init?.body).toBe(JSON.stringify({ mode: "manual" }));

    stubFetch(Response.json({ state: "failed", error: "not_connected" }));
    expect(await refreshGeminiUsage("auto")).toEqual({ state: "failed", error: "not_connected" });
  });

  test("refreshGeminiUsage は 401 を unauthorized、その他の失敗を null にする", async () => {
    stubFetch(new Response("{}", { status: 401 }));
    expect(await refreshGeminiUsage("auto")).toEqual({ unauthorized: true });

    stubFetch(new Response("{}", { status: 503 }));
    expect(await refreshGeminiUsage("auto")).toBeNull();

    stubFetch(Response.json({ state: "unknown" }));
    expect(await refreshGeminiUsage("auto")).toBeNull();
  });
});

describe("parseUsage", () => {
  test("provider: gemini の source を落とさず、plan と次回取得が無くても読む", () => {
    const payload = parseUsage({
      generatedAt: 1,
      sources: [
        {
          id: "gemini",
          provider: "gemini",
          name: "Gemini",
          plan: null,
          account: null,
          state: "ok",
          capturedAt: 1,
          fetchIntervalMs: 900_000,
          nextFetchAt: null,
          error: null,
          limitReached: false,
          windows: [
            { id: "rolling", label: "ローリング", durationSeconds: 18_000, usedPercent: 12, resetsAt: null },
            { id: "weekly", label: "週次", durationSeconds: 604_800, usedPercent: 3, resetsAt: 5 },
          ],
          notes: [],
          trends: [],
        },
      ],
    });

    expect(payload?.sources).toHaveLength(1);
    expect(payload?.sources[0]?.provider).toBe("gemini");
    expect(payload?.sources[0]?.plan).toBeNull();
    expect(payload?.sources[0]?.nextFetchAt).toBeNull();
    expect(payload?.sources[0]?.windows.map((window) => window.id)).toEqual(["rolling", "weekly"]);
  });
});
