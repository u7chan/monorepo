// 稼働状況の表示条件、色以外の状態表示、古い正常値を正常と見せないことを固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { fetchOpenCodeStatus, parseOpenCodeStatusPayload, type UsageSource } from "../src/client/api";
import {
  deriveOpenCodeStatus,
  hasActiveOpenCodeSource,
  serviceStatusLabel,
  statusReasonLabel,
} from "../src/client/lib/opencode-status";
import type { OpenCodeStatusPayload, OpenCodeStatusSnapshot } from "../src/shared/opencode-status";
import { BASE_TIME } from "./support";

function source(overrides: Partial<UsageSource> = {}): UsageSource {
  return {
    id: "account-a",
    provider: "opencode-go",
    name: "テスト用",
    plan: null,
    account: { id: "account-a", name: "テスト用", icon: "🦊" },
    state: "ok",
    capturedAt: BASE_TIME,
    error: null,
    limitReached: false,
    windows: [{ id: "rolling", label: "ローリング", durationSeconds: null, usedPercent: 0, resetsAt: null }],
    notes: [],
    trends: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<OpenCodeStatusSnapshot> = {}): OpenCodeStatusSnapshot {
  return {
    updatedAt: BASE_TIME,
    stale: false,
    status: "operational",
    reason: "none",
    since: BASE_TIME - 60_000,
    models: [],
    incidents: [],
    ...overrides,
  };
}

describe("hasActiveOpenCodeSource", () => {
  test("未登録・Codex だけ・まだ利用枠を取れていないときは表示しない", () => {
    expect(hasActiveOpenCodeSource([])).toBe(false);
    expect(hasActiveOpenCodeSource([source({ provider: "codex" })])).toBe(false);
    expect(hasActiveOpenCodeSource([source({ state: "loading", capturedAt: null })])).toBe(false);
    expect(hasActiveOpenCodeSource([source({ state: "error", capturedAt: null })])).toBe(false);
  });

  test("全件が契約・キーエラーなら、前回の利用枠があっても表示しない", () => {
    const invalid = ["subscription_required", "config", "not_connected"].map((code) =>
      source({
        state: "stale",
        error: { code, message: "テスト用", at: BASE_TIME },
      }),
    );

    expect(hasActiveOpenCodeSource(invalid)).toBe(false);
    expect(hasActiveOpenCodeSource([...invalid, source()])).toBe(true);
  });

  test("1 件以上有効なら表示し、利用枠の上限到達は契約無効と混ぜない", () => {
    expect(hasActiveOpenCodeSource([source()])).toBe(true);
    expect(
      hasActiveOpenCodeSource([
        source({
          limitReached: true,
          windows: [{ id: "monthly", label: "月次", durationSeconds: null, usedPercent: 100, resetsAt: null }],
        }),
      ]),
    ).toBe(true);
  });

  test("一時的な上流障害・schema 変化でステータス欄を消さない", () => {
    for (const code of ["upstream", "schema"]) {
      expect(
        hasActiveOpenCodeSource([source({ state: "stale", error: { code, message: "テスト用", at: BASE_TIME } })]),
      ).toBe(true);
    }
  });
});

describe("deriveOpenCodeStatus", () => {
  test("正常・性能低下・障害・不明を文言と記号で区別する", () => {
    expect(serviceStatusLabel("operational")).toEqual({ label: "正常稼働", tone: "success", symbol: "●" });
    expect(serviceStatusLabel("degraded")).toEqual({ label: "性能低下", tone: "attention", symbol: "▲" });
    expect(serviceStatusLabel("outage")).toEqual({ label: "障害", tone: "danger", symbol: "■" });
    expect(serviceStatusLabel("unknown")).toEqual({ label: "状態不明", tone: "neutral", symbol: "○" });
  });

  test("取得中と取得不可は Go の障害とは区別する", () => {
    expect(deriveOpenCodeStatus(null, BASE_TIME).label).toBe("取得中");
    expect(deriveOpenCodeStatus({ state: "error", snapshot: null }, BASE_TIME).label).toBe("取得不可");
  });

  test("前回値・上流の stale・5 分超の正常値を緑の正常稼働にしない", () => {
    for (const payload of [
      { state: "stale", snapshot: snapshot() },
      { state: "ok", snapshot: snapshot({ stale: true }) },
      { state: "ok", snapshot: snapshot({ updatedAt: BASE_TIME - 300_001 }) },
    ] satisfies OpenCodeStatusPayload[]) {
      expect(deriveOpenCodeStatus(payload, BASE_TIME)).toEqual({ label: "更新停止", tone: "attention", symbol: "▲" });
    }

    expect(deriveOpenCodeStatus({ state: "ok", snapshot: snapshot({ status: "degraded" }) }, BASE_TIME).label).toBe(
      "性能低下",
    );
  });

  test("遅延・上流・エラー率・接続障害を固定文言にする", () => {
    expect(statusReasonLabel("latency")).toContain("遅延");
    expect(statusReasonLabel("upstream")).toContain("上流");
    expect(statusReasonLabel("errors")).toContain("エラー率");
    expect(statusReasonLabel("availability")).toContain("接続障害");
    expect(statusReasonLabel("none")).toBeNull();
  });
});

describe("稼働状況 API のクライアント", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("正規化した状態・モデル・インシデントを読み取る", () => {
    const payload: OpenCodeStatusPayload = {
      state: "ok",
      snapshot: snapshot({
        status: "degraded",
        models: [{ id: "model-a", status: "degraded", reason: "latency" }],
        incidents: [{ startedAt: BASE_TIME, status: "degraded", reason: "latency", models: ["model-a"] }],
      }),
    };

    expect(parseOpenCodeStatusPayload(payload)).toEqual(payload);
    expect(parseOpenCodeStatusPayload({ state: "error", snapshot: null })).toEqual({ state: "error", snapshot: null });
  });

  test("壊れた応答や未知の状態を正常稼働にしない", () => {
    expect(parseOpenCodeStatusPayload(null)).toBeNull();
    expect(parseOpenCodeStatusPayload({ state: "ok", snapshot: null })).toBeNull();
    expect(
      parseOpenCodeStatusPayload({ state: "ok", snapshot: { updatedAt: BASE_TIME, status: "new" } })?.snapshot?.status,
    ).toBe("unknown");
  });

  test("認証切れと HTTP 失敗を区別する", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    expect(await fetchOpenCodeStatus()).toEqual({ unauthorized: true });
    globalThis.fetch = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    expect(await fetchOpenCodeStatus()).toBeNull();
  });
});
