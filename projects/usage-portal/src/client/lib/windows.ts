import type { UsageWindow } from "../api";

/**
 * 推移の初期表示。Codex と OpenCode Go で窓の id が違うため、正規化済みのラベルで選ぶ。
 * 週次が無いプランでは先頭の窓を出す。
 */
export function pickTrendWindow(windows: readonly UsageWindow[]): UsageWindow | null {
  return windows.find((window) => window.label.startsWith("週次")) ?? windows[0] ?? null;
}
