// 「5時間を開始」の表示・無効条件（未設定 / 未サインイン / snapshot なし / limitReached / 100% / 実行中）を固定する。
import { describe, expect, test } from "bun:test";
import type { UsageSource } from "../src/client/api";
import { canStartCodexWindow, probeErrorMessage } from "../src/client/lib/probe";
import { BASE_TIME } from "./support";

function source(overrides: Partial<UsageSource> = {}): UsageSource {
  return {
    id: "codex",
    provider: "codex",
    name: "Codex",
    plan: "Plus",
    account: null,
    state: "ok",
    capturedAt: BASE_TIME,
    error: null,
    limitReached: false,
    windows: [
      { id: "primary", label: "週次", durationSeconds: 604_800, usedPercent: 62, resetsAt: BASE_TIME + 60_000 },
    ],
    notes: [],
    trends: [],
    ...overrides,
  };
}

const base = { configured: true, signedIn: true, running: false };

describe("canStartCodexWindow", () => {
  test("未設定と未サインインでは押せない", () => {
    expect(canStartCodexWindow({ ...base, configured: false, source: source() })).toBe(false);
    expect(canStartCodexWindow({ ...base, signedIn: false, source: source() })).toBe(false);
  });

  test("snapshot が無い・取得前・取得エラーでは押せない", () => {
    expect(canStartCodexWindow({ ...base, source: null })).toBe(false);
    expect(canStartCodexWindow({ ...base, source: source({ state: "loading", capturedAt: null, windows: [] }) })).toBe(
      false,
    );
    expect(canStartCodexWindow({ ...base, source: source({ state: "error", windows: [] }) })).toBe(false);
    expect(canStartCodexWindow({ ...base, source: source({ windows: [] }) })).toBe(false);
  });

  test("limitReached といずれかの窓 100% では押せない", () => {
    expect(canStartCodexWindow({ ...base, source: source({ limitReached: true }) })).toBe(false);
    expect(
      canStartCodexWindow({
        ...base,
        source: source({
          windows: [{ id: "primary", label: "週次", durationSeconds: 604_800, usedPercent: 100, resetsAt: null }],
        }),
      }),
    ).toBe(false);
  });

  test("実行中は押せない", () => {
    expect(canStartCodexWindow({ ...base, running: true, source: source() })).toBe(false);
  });

  test("未使用 0% と未来のリセット時刻では押せる", () => {
    expect(
      canStartCodexWindow({
        ...base,
        source: source({
          windows: [
            { id: "primary", label: "週次", durationSeconds: 604_800, usedPercent: 0, resetsAt: BASE_TIME + 60_000 },
          ],
        }),
      }),
    ).toBe(true);
  });

  test("送信直後でも押せる（開始済みを判定しない）と、stale の窓でも押せる", () => {
    expect(
      canStartCodexWindow({
        ...base,
        source: source({
          windows: [{ id: "primary", label: "週次", durationSeconds: 18_000, usedPercent: 12, resetsAt: null }],
        }),
      }),
    ).toBe(true);
    expect(canStartCodexWindow({ ...base, source: source({ state: "stale" }) })).toBe(true);
  });

  test("週次だけを返すアカウントでも、100% 未満なら押せる", () => {
    expect(
      canStartCodexWindow({
        ...base,
        source: source({
          windows: [
            {
              id: "primary",
              label: "週次",
              durationSeconds: 604_800,
              usedPercent: 83,
              resetsAt: BASE_TIME + 5 * 24 * 60 * 60 * 1000,
            },
          ],
        }),
      }),
    ).toBe(true);
  });
});

describe("probeErrorMessage", () => {
  test("既知のコードは固定文言にし、未知のコードも文言を返す", () => {
    expect(probeErrorMessage("model_unavailable")).toContain("モデル");
    expect(probeErrorMessage("invalid_key")).toContain("API キー");
    expect(probeErrorMessage("reauth_required")).toContain("サインイン");
    expect(probeErrorMessage("something-new").length).toBeGreaterThan(0);
  });
});
