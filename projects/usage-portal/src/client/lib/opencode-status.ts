import {
  type OpenCodeStatusPayload,
  type ServiceStatus,
  type StatusReason,
  statusIsOld,
} from "../../shared/opencode-status";
import type { UsageSource } from "../api";
import type { ProviderStatus } from "./status";

export function hasActiveOpenCodeSource(sources: readonly UsageSource[]): boolean {
  return sources.some(
    (source) =>
      source.provider === "opencode-go" &&
      source.capturedAt !== null &&
      (source.state === "ok" || source.state === "stale") &&
      source.error?.code !== "not_connected" &&
      source.error?.code !== "subscription_required" &&
      source.error?.code !== "config",
  );
}

export function mergeOpenCodeStatusPayload(
  previous: OpenCodeStatusPayload | null,
  incoming: OpenCodeStatusPayload | null,
): OpenCodeStatusPayload {
  if (incoming?.snapshot) {
    return incoming;
  }

  return { state: previous?.snapshot ? "stale" : "error", snapshot: previous?.snapshot ?? null };
}

export function serviceStatusLabel(status: ServiceStatus): ProviderStatus {
  switch (status) {
    case "operational":
      return { label: "正常稼働", tone: "success", symbol: "●" };
    case "degraded":
      return { label: "性能低下", tone: "attention", symbol: "▲" };
    case "outage":
      return { label: "障害", tone: "danger", symbol: "■" };
    default:
      return { label: "状態不明", tone: "neutral", symbol: "○" };
  }
}

export function deriveOpenCodeStatus(payload: OpenCodeStatusPayload | null, now: number): ProviderStatus {
  if (!payload) {
    return { label: "取得中", tone: "neutral", symbol: "○" };
  }

  if (payload.state === "error" || !payload.snapshot) {
    return { label: "取得不可", tone: "neutral", symbol: "○" };
  }

  if (payload.state === "stale" || statusIsOld(payload.snapshot, now)) {
    return { label: "更新停止", tone: "attention", symbol: "▲" };
  }

  return serviceStatusLabel(payload.snapshot.status);
}

export function statusReasonLabel(reason: StatusReason): string | null {
  switch (reason) {
    case "latency":
      return "応答開始の遅延";
    case "upstream":
      return "上流プロバイダーの問題";
    case "errors":
      return "エラー率の増加";
    case "availability":
      return "サービスへの接続障害";
    case "unknown":
      return "原因は公式ページで確認してください";
    default:
      return null;
  }
}
