import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Dispatch } from "react";
import { getCatalog, getHealth } from "../api";
import { selectableAgents } from "../lib/agentSelection";
import { createCatalogStore } from "../lib/catalogStore";
import type { CatalogResponse, Health } from "../types";
import type { ChatAction } from "./chatReducer";
import { runtimeStatusForHealth, type RuntimeStatus } from "./runtimeStatus";
import { createMountScope } from "./requestGate";

const AGENT_KEY = "u7agent-agent";
const alwaysCurrent = () => true;

/** 取得前のカタログ。ビルトインは null で、ツール欄は空を「取得できていない」として理由を出す */
const EMPTY_CATALOG: CatalogResponse = {
  builtinAgent: null,
  builtinSkills: [],
  agents: [],
  skills: [],
  tools: [],
};

export type UseRuntimeCatalogParams = {
  dispatch: Dispatch<ChatAction>;
};

export function useRuntimeCatalog({ dispatch }: UseRuntimeCatalogParams) {
  const [mountScope] = useState(createMountScope);
  useEffect(mountScope.setup, [mountScope]);
  const [health, setHealth] = useState<Health | null>(null);
  const [catalogStore] = useState(() => createCatalogStore(EMPTY_CATALOG));
  const catalog = useSyncExternalStore(catalogStore.subscribe, catalogStore.get);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>({ text: "起動中", error: false });
  const [agentId, setAgentIdState] = useState<string>(() => localStorage.getItem(AGENT_KEY) || "");

  const setAgentId = useCallback(
    (id: string) => {
      if (!mountScope.isActive()) return;
      setAgentIdState(id);
      localStorage.setItem(AGENT_KEY, id);
    },
    [mountScope],
  );

  const applyHealth = useCallback(
    (next: Health) => {
      setHealth(next);
      const status = runtimeStatusForHealth(next);
      setRuntimeStatus(status);
      if (status.error && !next.ready && status.detail) {
        dispatch({ type: "setActivity", text: status.detail });
      }
    },
    [dispatch],
  );

  const refreshHealth = useCallback(
    async (isCurrent = alwaysCurrent): Promise<Health | null> => {
      const canApply = mountScope.capture();
      try {
        const next = await getHealth();
        if (!canApply() || !isCurrent()) return null;
        applyHealth(next);
        return next;
      } catch {
        return null;
      }
    },
    [applyHealth, mountScope],
  );

  const normalizeAgentId = useCallback(
    (next: CatalogResponse): string => {
      // フォールバックはビルトイン (先頭)。ユーザー定義が 0 件でも選択が空にならない
      const nextAgents = selectableAgents(next);
      const valid = nextAgents.some((agent) => agent.id === agentId);
      const id = valid ? agentId : nextAgents[0]?.id || "";
      localStorage.setItem(AGENT_KEY, id);
      setAgentIdState(id);
      return id;
    },
    [agentId],
  );

  const loadCatalog = useCallback(
    async (isCurrent = alwaysCurrent): Promise<CatalogResponse> => {
      const canApply = mountScope.capture();
      const apply = catalogStore.begin();
      const next = await getCatalog();
      if (!canApply() || !isCurrent()) return next;
      if (apply(next)) normalizeAgentId(next);
      return next;
    },
    [catalogStore, normalizeAgentId, mountScope],
  );

  /**
   * 並べ替えの確定した順を共有カタログへ反映する入口。反映と同時に取得の世代を進めるので、
   * これより前に開始して遅れて届いた取得は採用されない（client/src/lib/catalogStore.ts）。
   */
  const applyAgentOrder = useCallback(
    (ids: readonly string[]) => {
      catalogStore.adoptOrder(ids);
    },
    [catalogStore],
  );

  // 一覧とピッカーが使う並び。catalog が変わるまで同じ配列を渡す (下流の useCallback を安定させる)
  const agents = useMemo(() => selectableAgents(catalog), [catalog]);
  const selectedAgent = agents.find((agent) => agent.id === agentId);

  return {
    health,
    catalog,
    agents,
    runtimeStatus,
    setRuntimeStatus,
    agentId,
    setAgentId,
    selectedAgent,
    loadCatalog,
    /** 並べ替えの確定順を共有カタログへ反映する（App 経由で設定 → エージェントへ渡す） */
    applyAgentOrder,
    refreshHealth,
    applyHealth,
  };
}
