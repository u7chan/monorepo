import type { CostMasterPayload } from "../shared/contract";

export async function fetchModels(signal: AbortSignal): Promise<CostMasterPayload> {
  const response = await fetch("/api/models", { signal, headers: { Accept: "application/json" } });

  if (!response.ok) {
    throw new Error(`マスタを取得できませんでした (HTTP ${response.status})`);
  }

  return (await response.json()) as CostMasterPayload;
}
