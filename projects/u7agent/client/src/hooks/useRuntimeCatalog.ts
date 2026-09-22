import { useCallback, useMemo, useState } from "react";
import type { Dispatch } from "react";
import { getCatalog, getHealth } from "../api";
import { selectableAgents } from "../lib/agentSelection";
import type { CatalogResponse, Health } from "../types";
import type { ChatAction } from "./chatReducer";
import { runtimeStatusForHealth, type RuntimeStatus } from "./runtimeStatus";

const AGENT_KEY = "u7agent-agent";
const alwaysCurrent = () => true;

export type UseRuntimeCatalogParams = {
  dispatch: Dispatch<ChatAction>;
};

export function useRuntimeCatalog({ dispatch }: UseRuntimeCatalogParams) {
  const [health, setHealth] = useState<Health | null>(null);
  const [catalog, setCatalog] = useState<CatalogResponse>({
    builtinAgent: null,
    builtinSkills: [],
    agents: [],
    skills: [],
  });
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>({ text: "起動中", error: false });
  const [agentId, setAgentIdState] = useState<string>(() => localStorage.getItem(AGENT_KEY) || "");

  const setAgentId = useCallback((id: string) => {
    setAgentIdState(id);
    localStorage.setItem(AGENT_KEY, id);
  }, []);

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
      try {
        const next = await getHealth();
        if (!isCurrent()) return null;
        applyHealth(next);
        return next;
      } catch {
        return null;
      }
    },
    [applyHealth],
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
      const next = await getCatalog();
      if (!isCurrent()) return next;
      setCatalog(next);
      normalizeAgentId(next);
      return next;
    },
    [normalizeAgentId],
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
    refreshHealth,
    applyHealth,
  };
}
