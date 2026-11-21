// ContainerList Component - コンテナ一覧・絞り込み・表示形式の切り替え

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Container, ContainerFilter } from "../types/container";
import { ContainerCard, ContainerListItem, type ContainerAction } from "./ContainerCard";
import { GLASS } from "./glass";
import { GridIcon, ListIcon, TrayIcon, WarningIcon } from "./icons";
import { SegmentedControl, type SegmentedOption } from "./SegmentedControl";
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

const VIEW_MODE_OPTIONS: readonly SegmentedOption<ViewMode>[] = [
  { value: "grid", label: <GridIcon className="size-[18px]" />, ariaLabel: "Card view" },
  { value: "list", label: <ListIcon className="size-[18px]" />, ariaLabel: "List view" },
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

/**
 * 絞り込み。狭い画面では親指の届く下端に浮かべ (ガラスのカプセル)、広い画面では
 * 上の行に通常のセグメントとして置く。DOM は 1 つで、見た目だけを切り替える。
 */
function FilterBar({
  filter,
  counts,
  onChange,
}: {
  filter: ContainerFilter;
  counts: Record<ContainerFilter, number>;
  onChange: (filter: ContainerFilter) => void;
}) {
  const options = FILTERS.map(({ value, label }) => ({
    value,
    label: (
      <span className="inline-flex flex-wrap items-baseline justify-center gap-x-1.5">
        {label}
        <span className="font-mono text-[0.875em] font-normal tabular-nums">{counts[value]}</span>
      </span>
    ),
  }));

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 pr-[max(1rem,env(safe-area-inset-right))] pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] md:pointer-events-auto md:static md:z-auto md:w-80 md:p-0">
      <div
        className={`${GLASS} pointer-events-auto mx-auto max-w-md rounded-full p-1 shadow-float md:contents`}
      >
        <SegmentedControl
          label="Filter containers"
          options={options}
          value={filter}
          onChange={onChange}
          trackClassName="rounded-full bg-transparent md:rounded-control md:bg-fill"
          thumbClassName="rounded-full bg-fill-strong md:rounded-[0.625rem] md:bg-thumb md:shadow-thumb"
          segmentClassName="min-h-10 px-2 md:min-h-8 md:px-3"
        />
      </div>
    </div>
  );
}

/**
 * 初回読み込み中のプレースホルダ。スピナーより、これから出る形を見せるほうが
 * レイアウトの跳ねが少なく、待ち時間の見積もりもしやすい。
 */
function CardSkeleton() {
  return (
    <div className="rounded-card bg-surface p-4 shadow-card">
      <div className="h-4 w-2/5 rounded-md bg-fill" />
      <div className="mt-2 h-3.5 w-1/3 rounded-md bg-fill" />
      <div className="mt-4 h-14 rounded-tile bg-fill" />
      <div className="mt-4 h-3.5 w-1/2 rounded-md bg-fill" />
    </div>
  );
}

function StatePanel({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-card bg-surface px-6 py-14 text-center shadow-card">
      <div className="grid size-14 place-items-center rounded-full bg-fill text-label-2">
        {icon}
      </div>
      <p className="mt-4 text-title-3 font-semibold text-label">{title}</p>
      <p className="mt-1.5 max-w-sm text-subhead text-label-2">{description}</p>
      {action && <div className="mt-5">{action}</div>}
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
        // リンクを出さないコンテナ (portal.hidden) のポートは数えない。
        .filter((item) => !item.hidden && isPortReachable(item.state))
        .reduce((total, item) => total + item.ports.length, 0),
    [state.containers],
  );

  const isInitialLoading = state.loading && state.containers.length === 0;

  const renderItem = (container: Container, Item: typeof ContainerCard) => (
    <Item
      key={container.id}
      container={container}
      pendingAction={pendingAction?.containerId === container.id ? pendingAction.action : null}
      onAction={runContainerAction}
    />
  );

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <FilterBar filter={filter} counts={counts} onChange={setFilter} />

        <div className="flex min-w-0 flex-1 items-center justify-between gap-3 md:justify-end md:gap-4">
          <div className="min-w-0 md:flex md:items-center md:gap-4">
            <p className="flex items-center gap-1.5 text-subhead text-label-2">
              <span
                aria-hidden="true"
                className={[
                  "size-2 shrink-0 rounded-full",
                  livePortCount > 0 ? "bg-live" : "bg-label-3",
                ].join(" ")}
              />
              <span>
                <span className="font-medium text-label tabular-nums">{livePortCount}</span>{" "}
                {livePortCount === 1 ? "live port" : "live ports"}
              </span>
            </p>
            {state.lastUpdated && (
              <p
                className="text-footnote text-label-2 tabular-nums md:text-subhead"
                title={`Refreshes every ${Math.round(refreshInterval / 1000)} seconds`}
              >
                Updated {formatTime(state.lastUpdated)}
              </p>
            )}
          </div>

          <SegmentedControl
            label="View"
            options={VIEW_MODE_OPTIONS}
            value={viewMode}
            onChange={setViewMode}
            segmentClassName="w-10"
          />
        </div>
      </div>

      {state.actionError && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-tile bg-surface px-4 py-3 text-subhead text-label shadow-card"
        >
          <WarningIcon className="mt-px size-5 shrink-0 text-dead" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{state.actionError}</span>
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
          icon={<WarningIcon className="size-7" />}
          title="Can't reach Docker"
          description={state.error}
          action={
            <button
              type="button"
              onClick={() => void load()}
              className="min-h-11 rounded-full bg-accent-fill px-6 text-callout font-semibold text-white transition-[filter,scale] duration-150 can-hover:hover:brightness-110 active:scale-[0.97] active:brightness-90"
            >
              Try again
            </button>
          }
        />
      )}

      {!isInitialLoading && !state.error && visibleContainers.length === 0 && (
        <StatePanel
          icon={<TrayIcon className="size-7" />}
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
            {visibleContainers.map((container) => renderItem(container, ContainerCard))}
          </div>
        ) : (
          <div className="divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
            {visibleContainers.map((container) => renderItem(container, ContainerListItem))}
          </div>
        ))}
    </section>
  );
}

export default ContainerList;
