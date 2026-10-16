/**
 * 共有カタログ（health / catalog を配る useRuntimeCatalog）の取得と並びの採用を 1 箇所へ閉じる。
 * **後から開始した取得だけを採用する**: 並べ替えの確定も同じ世代を進めるため、確定より前に
 * 開始して遅れて届いた取得は、確定した並びを丸ごと巻き戻せない（client/src/hooks/requestGate.ts）。
 */
import { createRequestGate } from "../hooks/requestGate";
import type { CatalogResponse } from "../types";
import { applyAgentOrder } from "./agentReorder";

export type CatalogStore = {
  get(): CatalogResponse;
  subscribe(listener: () => void): () => void;
  /**
   * 取得の開始。返した関数で応答を適用する。**先行する取得の応答は捨てる**ので、
   * 適用できたときだけ true を返す。
   */
  begin(): (next: CatalogResponse) => boolean;
  /** 確定した並びを即時に反映する。定義はそのまま使い、順序だけを差し替える */
  adoptOrder(ids: readonly string[]): void;
};

export function createCatalogStore(initial: CatalogResponse): CatalogStore {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const gate = createRequestGate();
  const publish = (next: CatalogResponse) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    begin() {
      const isCurrent = gate();
      return (next) => {
        if (!isCurrent()) return false;
        publish(next);
        return true;
      };
    },
    adoptOrder(ids) {
      // 確定は「それまでに開始した取得より新しい」ものとして扱う (編集の保存が起こす取り直しと重なっても、
      // 確定順が古い並びで置き換わらない)
      gate();
      publish({ ...snapshot, agents: applyAgentOrder(snapshot.agents, ids) });
    },
  };
}
