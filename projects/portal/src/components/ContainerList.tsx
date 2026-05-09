// ContainerList Component - コンテナ一覧をグリッド/リストで表示

import { useState, useEffect } from "react";
import type { Container, ContainerFilter } from "../types/container";
import { ContainerCard, ContainerListItem } from "./ContainerCard";

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

type ViewMode = "grid" | "list";

const VIEW_MODE_STORAGE_KEY = "portal.containerViewMode";

/**
 * 表示切り替えボタンコンポーネント
 */
function ViewModeButton({
  active,
  label,
  title,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={`
        inline-flex h-9 w-9 items-center justify-center rounded-lg border transition-all duration-200
        ${
          active
            ? "border-cyan-500/50 bg-cyan-500/20 text-cyan-300 shadow-[0_0_15px_rgba(6,182,212,0.22)]"
            : "border-slate-700/50 bg-slate-800/50 text-slate-500 hover:border-slate-600 hover:text-slate-300"
        }
      `}
    >
      {children}
    </button>
  );
}

/**
 * コンテナ一覧コンポーネント
 */
export function ContainerList({ filter = "all", refreshInterval = 30000 }: ContainerListProps) {
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window === "undefined") {
      return "grid";
    }

    const savedMode = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return savedMode === "list" ? "list" : "grid";
  });
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

  useEffect(() => {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
  }, [viewMode]);

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
      <div className="flex flex-col gap-3 px-1 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-slate-400">
          <span className="font-semibold text-slate-200">{state.containers.length}</span>{" "}
          {state.containers.length === 1 ? "container" : "containers"}
          {filter !== "all" && <span className="text-slate-500"> ({filter})</span>}
        </p>
        <div className="flex items-center gap-3">
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
          <div className="flex items-center gap-1 rounded-xl border border-slate-700/50 bg-slate-900/40 p-1">
            <ViewModeButton
              active={viewMode === "grid"}
              label="Grid view"
              title="カード表示"
              onClick={() => setViewMode("grid")}
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h6v6h-6v-6z"
                />
              </svg>
            </ViewModeButton>
            <ViewModeButton
              active={viewMode === "list"}
              label="List view"
              title="リスト表示"
              onClick={() => setViewMode("list")}
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"
                />
              </svg>
            </ViewModeButton>
          </div>
        </div>
      </div>

      {viewMode === "grid" ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {state.containers.map((container) => (
            <ContainerCard key={container.id} container={container} />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {state.containers.map((container) => (
            <ContainerListItem key={container.id} container={container} />
          ))}
        </div>
      )}
    </div>
  );
}

export default ContainerList;
