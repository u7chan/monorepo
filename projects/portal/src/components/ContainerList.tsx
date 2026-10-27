// ContainerList Component - コンテナ一覧・絞り込み・表示形式の切り替え

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Container, ContainerFilter } from "../types/container";
import { ContainerCard, ContainerListItem, type ContainerAction } from "./ContainerCard";
import { isPortReachable } from "../lib/containerState";

interface ContainerListProps {
  refreshInterval?: number;
}

interface FetchState {
  containers: Container[];
  loading: boolean;
  error: string | null;
  actionError: string | null;
  lastUpdated: Date | null;
}

type ViewMode = "grid" | "list";

const VIEW_MODE_STORAGE_KEY = "portal.containerViewMode";

const FILTERS: { value: ContainerFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "stopped", label: "Stopped" },
];

function matchesFilter(container: Container, filter: ContainerFilter): boolean {
  if (filter === "running") {
    return container.state === "running";
  }

  if (filter === "stopped") {
    return container.state === "exited" || container.state === "dead";
  }

  return true;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function FilterBar({
  filter,
  counts,
  onChange,
}: {
  filter: ContainerFilter;
  counts: Record<ContainerFilter, number>;
  onChange: (filter: ContainerFilter) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Filter containers"
      className="inline-flex items-center gap-0.5 rounded-lg border border-line bg-ink-900 p-0.5"
    >
      {FILTERS.map(({ value, label }) => {
        const active = filter === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(value)}
            className={[
              "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors duration-150",
              active ? "bg-ink-700 text-fg" : "text-fg-3 hover:text-fg-2",
            ].join(" ")}
          >
            {label}
            <span
              className={[
                "font-mono text-[11px] tabular-nums",
                active ? "text-fg-2" : "text-fg-3",
              ].join(" ")}
            >
              {counts[value]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ViewModeButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={[
        "inline-flex size-7 items-center justify-center rounded-md transition-colors duration-150",
        active ? "bg-ink-700 text-fg" : "text-fg-3 hover:text-fg-2",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function GridIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      className="size-3.5"
    >
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      className="size-3.5"
    >
      <path d="M6 4h7.5M6 8h7.5M6 12h7.5" />
      <path d="M2.75 4h.01M2.75 8h.01M2.75 12h.01" strokeWidth="1.8" />
    </svg>
  );
}

/**
 * 初回読み込み中のプレースホルダ。スピナーより、これから出る形を見せるほうが
 * レイアウトの跳ねが少なく、待ち時間の見積もりもしやすい。
 */
function CardSkeleton() {
  return (
    <div className="rounded-xl border border-line bg-ink-900 p-4">
      <div className="h-3 w-2/5 rounded-sm bg-ink-800" />
      <div className="mt-4 flex gap-2">
        <div className="h-[62px] flex-1 rounded-lg bg-ink-850" />
        <div className="h-[62px] flex-1 rounded-lg bg-ink-850" />
      </div>
      <div className="mt-4 h-2.5 w-1/3 rounded-sm bg-ink-800" />
    </div>
  );
}

function StatePanel({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-line py-16 text-center">
      <p className="text-[14px] font-semibold text-fg">{title}</p>
      <p className="mt-1.5 max-w-sm text-[12.5px] leading-relaxed text-fg-3">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * コンテナ一覧コンポーネント
 */
export function ContainerList({ refreshInterval = 30000 }: ContainerListProps) {
  const [filter, setFilter] = useState<ContainerFilter>("all");
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
    actionError: null,
    lastUpdated: null,
  });
  const [pendingAction, setPendingAction] = useState<{
    containerId: string;
    action: ContainerAction;
  } | null>(null);

  // 絞り込みはクライアント側で行う。フィルタごとの件数を出すには全件が要るのと、
  // 切り替えのたびに docker ps を叩き直さずに済むため。
  const load = useCallback(async () => {
    try {
      setState((prev) => ({ ...prev, loading: true, error: null }));

      const response = await fetch("/api/containers");

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      setState({
        containers: data.containers || [],
        loading: false,
        error: null,
        actionError: null,
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
  }, []);

  const runContainerAction = useCallback(
    async (container: Container, action: ContainerAction) => {
      try {
        setPendingAction({ containerId: container.id, action });
        setState((prev) => ({ ...prev, actionError: null }));

        const response = await fetch(`/api/containers/${container.id}/${action}`, {
          method: "POST",
        });
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.message || `HTTP error! status: ${response.status}`);
        }

        if (data.mock) {
          setState((prev) => ({
            ...prev,
            containers: prev.containers.map((item) =>
              item.id === container.id
                ? {
                    ...item,
                    state: action === "start" ? ("running" as const) : ("exited" as const),
                    status: action === "start" ? "Up just now" : "Exited (0) just now",
                  }
                : item,
            ),
            lastUpdated: new Date(),
          }));
          return;
        }

        await load();
      } catch (error) {
        console.error(`Failed to ${action} container:`, error);
        setState((prev) => ({
          ...prev,
          actionError: error instanceof Error ? error.message : `Failed to ${action} container`,
        }));
      } finally {
        setPendingAction(null);
      }
    },
    [load],
  );

  // 初回読み込みと定期更新
  useEffect(() => {
    void load();

    if (refreshInterval > 0) {
      const interval = setInterval(() => void load(), refreshInterval);
      return () => clearInterval(interval);
    }
  }, [load, refreshInterval]);

  useEffect(() => {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
  }, [viewMode]);

  const counts = useMemo<Record<ContainerFilter, number>>(
    () => ({
      all: state.containers.length,
      running: state.containers.filter((item) => matchesFilter(item, "running")).length,
      stopped: state.containers.filter((item) => matchesFilter(item, "stopped")).length,
    }),
    [state.containers],
  );

  const visibleContainers = useMemo(
    () => state.containers.filter((item) => matchesFilter(item, filter)),
    [state.containers, filter],
  );

  const livePortCount = useMemo(
    () =>
      state.containers
        .filter((item) => isPortReachable(item.state))
        .reduce((total, item) => total + item.ports.length, 0),
    [state.containers],
  );

  const isInitialLoading = state.loading && state.containers.length === 0;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterBar filter={filter} counts={counts} onChange={setFilter} />

        <div className="flex items-center gap-3">
          <p className="flex items-center gap-1.5 text-[11.5px] text-fg-3">
            <span
              aria-hidden="true"
              className={[
                "size-1.5 rounded-full",
                livePortCount > 0 ? "bg-live" : "bg-line-strong",
              ].join(" ")}
            />
            <span className="text-fg-2 tabular-nums">{livePortCount}</span>
            {livePortCount === 1 ? "live port" : "live ports"}
          </p>

          {state.lastUpdated && (
            <p
              className="hidden text-[11.5px] text-fg-3 tabular-nums sm:block"
              title={`Refreshes every ${Math.round(refreshInterval / 1000)} seconds`}
            >
              Updated {formatTime(state.lastUpdated)}
            </p>
          )}

          <div className="flex items-center gap-0.5 rounded-lg border border-line bg-ink-900 p-0.5">
            <ViewModeButton
              active={viewMode === "grid"}
              label="Grid view"
              onClick={() => setViewMode("grid")}
            >
              <GridIcon />
            </ViewModeButton>
            <ViewModeButton
              active={viewMode === "list"}
              label="List view"
              onClick={() => setViewMode("list")}
            >
              <ListIcon />
            </ViewModeButton>
          </div>
        </div>
      </div>

      {state.actionError && (
        <div
          role="alert"
          className="rounded-lg border border-dead/30 bg-dead/10 px-3 py-2 text-[12px] text-dead"
        >
          {state.actionError}
        </div>
      )}

      {isInitialLoading && (
        <div role="status" aria-live="polite">
          <span className="sr-only">Loading containers</span>
          <div className="grid animate-pulse grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
          </div>
        </div>
      )}

      {!isInitialLoading && state.error && state.containers.length === 0 && (
        <StatePanel
          title="Can't reach Docker"
          description={state.error}
          action={
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex h-8 items-center rounded-md border border-line-strong px-3 text-[12px] font-medium text-fg transition-colors hover:bg-ink-800"
            >
              Try again
            </button>
          }
        />
      )}

      {!isInitialLoading && !state.error && visibleContainers.length === 0 && (
        <StatePanel
          title={filter === "all" ? "No containers" : `No ${filter} containers`}
          description={
            filter === "all"
              ? "Nothing is running on this host yet."
              : filter === "running"
                ? "Start a container, or switch the filter to All."
                : "Everything that exists here is still running."
          }
        />
      )}

      {visibleContainers.length > 0 &&
        (viewMode === "grid" ? (
          <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visibleContainers.map((container) => (
              <ContainerCard
                key={container.id}
                container={container}
                pendingAction={
                  pendingAction?.containerId === container.id ? pendingAction.action : null
                }
                onAction={runContainerAction}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {visibleContainers.map((container) => (
              <ContainerListItem
                key={container.id}
                container={container}
                pendingAction={
                  pendingAction?.containerId === container.id ? pendingAction.action : null
                }
                onAction={runContainerAction}
              />
            ))}
          </div>
        ))}
    </section>
  );
}

export default ContainerList;
