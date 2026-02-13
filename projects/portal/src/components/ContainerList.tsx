// ContainerList Component - コンテナ一覧をグリッドレイアウトで表示

import { useState, useEffect } from "react";
import type { Container, ContainerFilter } from "../types/container";
import { ContainerCard } from "./ContainerCard";

interface ContainerListProps {
  filter?: ContainerFilter;
  refreshInterval?: number;
}

interface FetchState {
  containers: Container[];
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
}

/**
 * コンテナ一覧コンポーネント
 */
export function ContainerList({ filter = "all", refreshInterval = 30000 }: ContainerListProps) {
  const [state, setState] = useState<FetchState>({
    containers: [],
    loading: true,
    error: null,
    lastUpdated: null,
  });

  const fetchContainers = async () => {
    try {
      setState((prev) => ({ ...prev, loading: true, error: null }));

      const response = await fetch(`/api/containers?filter=${filter}`);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      setState({
        containers: data.containers || [],
        loading: false,
        error: null,
        lastUpdated: new Date(),
      });
    } catch (error) {
      console.error("Failed to fetch containers:", error);
      setState((prev) => ({
        ...prev,
        loading: false,
        error: error instanceof Error ? error.message : "Failed to fetch containers",
      }));
    }
  };

  // 初回読み込みと定期更新
  useEffect(() => {
    fetchContainers();

    if (refreshInterval > 0) {
      const interval = setInterval(fetchContainers, refreshInterval);
      return () => clearInterval(interval);
    }
  }, [filter, refreshInterval]);

  // ローディング状態
  if (state.loading && state.containers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div className="relative">
          <div className="w-12 h-12 border-4 border-cyan-500/20 border-t-cyan-400 rounded-full animate-spin" />
          <div
            className="absolute inset-0 w-12 h-12 border-4 border-transparent border-t-purple-500/30
                       rounded-full animate-spin"
            style={{ animationDuration: "1.5s" }}
          />
        </div>
        <p className="mt-4 text-slate-400 animate-pulse">Loading containers...</p>
      </div>
    );
  }

  // エラー状態
  if (state.error && state.containers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div
          className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500/30
                     flex items-center justify-center mb-4"
        >
          <svg
            className="w-8 h-8 text-red-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <h3 className="text-lg font-semibold text-slate-200 mb-2">Failed to load containers</h3>
        <p className="text-slate-400 text-center max-w-md mb-4">{state.error}</p>
        <button
          onClick={fetchContainers}
          className="px-4 py-2 rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/30
                     hover:bg-cyan-500/20 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  // 空の状態
  if (state.containers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div
          className="w-16 h-16 rounded-full bg-slate-700/30 border border-slate-600/30
                     flex items-center justify-center mb-4"
        >
          <svg
            className="w-8 h-8 text-slate-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
            />
          </svg>
        </div>
        <h3 className="text-lg font-semibold text-slate-300 mb-2">No containers found</h3>
        <p className="text-slate-500 text-center">
          {filter === "all"
            ? "No Docker containers are running or stopped."
            : filter === "running"
              ? "No running containers found."
              : "No stopped containers found."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ヘッダー: カウントと最終更新 */}
      <div className="flex items-center justify-between px-1">
        <p className="text-sm text-slate-400">
          <span className="font-semibold text-slate-200">{state.containers.length}</span>{" "}
          {state.containers.length === 1 ? "container" : "containers"}
          {filter !== "all" && <span className="text-slate-500"> ({filter})</span>}
        </p>
        {state.lastUpdated && (
          <p className="text-xs text-slate-500">
            Updated{" "}
            {state.lastUpdated.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </p>
        )}
      </div>

      {/* グリッドレイアウト */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {state.containers.map((container) => (
          <ContainerCard key={container.id} container={container} />
        ))}
      </div>
    </div>
  );
}

export default ContainerList;
