import { useEffect, useRef, useState } from "react";
import { useRuntimeDebugServe } from "../../hooks/useRuntimeDebugServe";
import { useRuntimeServe } from "../../hooks/useRuntimeServe";
import { createRuntimeReloadGate, type RuntimeReloadGate } from "../../lib/runtimeEnvironment";
import type { Health } from "../../types";
import { ReloadButton } from "../ReloadButton";
import { RuntimeDebugServiceCard } from "../RuntimeDebugServiceCard";
import { RuntimeServiceCard } from "../RuntimeServiceCard";
import { RuntimeTabLayout, type RuntimeTabProps } from "./RuntimeTabLayout";

/**
 * 設定 → ランタイム の「サービス」面。公開中のサービスの確認・停止と、公開 URL を組む health、
 * デバッグ用 (18000 帯) の一覧・強制停止を持つ。取得は別系統に分け、デバッグの失敗で公開カードを壊さない。
 * 4 秒ポーリングはこの面が mount されている間だけ動く。
 */
export function ServiceTab({
  health,
  onRefreshHealth,
  onOpenSession,
  ...tabProps
}: RuntimeTabProps & {
  health: Health | null;
  onRefreshHealth: (isCurrent?: () => boolean) => Promise<Health | null>;
  onOpenSession?: (sessionId: string, spaceId?: string) => void;
}) {
  const service = useRuntimeServe();
  const debug = useRuntimeDebugServe();
  const [refreshing, setRefreshing] = useState(false);
  const gateRef = useRef<RuntimeReloadGate | null>(null);
  if (gateRef.current === null) gateRef.current = createRuntimeReloadGate();
  const gate = gateRef.current;
  useEffect(() => () => gate.invalidate(), [gate]);

  const reload = async (): Promise<void> => {
    const isCurrent = gate.begin();
    setRefreshing(true);
    await Promise.allSettled([onRefreshHealth(isCurrent), service.refresh(), debug.refresh()]);
    if (isCurrent()) setRefreshing(false);
  };

  return (
    <RuntimeTabLayout
      {...tabProps}
      actions={
        <ReloadButton onClick={() => void reload()} disabled={refreshing}>
          再読み込み
        </ReloadButton>
      }
    >
      <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
        <div className="mx-auto grid max-w-4xl gap-3">
          <RuntimeServiceCard
            state={service}
            hostname={location.hostname}
            port={health?.previewPort}
            onStop={() => void service.stop()}
            onOpenSession={onOpenSession}
          />
          <RuntimeDebugServiceCard
            state={debug}
            onStop={(port) => void debug.stop(port)}
            onOpenSession={onOpenSession}
          />
        </div>
      </div>
    </RuntimeTabLayout>
  );
}
