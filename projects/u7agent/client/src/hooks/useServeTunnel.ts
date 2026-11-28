import { useCallback, useEffect, useSyncExternalStore } from "react";
import { getServeTunnel, startServeTunnel, stopServeTunnel } from "../api/runtime";
import {
  createServeTunnelController,
  createServeTunnelNotices,
  createServeTunnelReloadGroup,
  INITIAL_SERVE_TUNNEL_STATE,
  type ServeTunnelHandle,
  type ServeTunnelStartResult,
  type ServeTunnelState,
} from "../lib/serveTunnel";
import type { ServeTunnelStartBody } from "../types";
import { useRuntimePolling } from "./useRuntimePolling";

/** 画面の生存期間で 1 つだけ持つ。App はスペース切替で作り直され、入口も 2 か所あるため、通知を state に置かない */
const pageNotices = createServeTunnelNotices();
const pageReload = createServeTunnelReloadGroup();

const createController = (_confirm: unknown, onChange: (state: ServeTunnelState) => void) =>
  createServeTunnelController({
    getStatus: () => getServeTunnel(AbortSignal.timeout(15_000)),
    // 開始は同期で、起動基盤の期限と DNS の確認の上限の合計まで続く。それより先に切らない
    start: (input) => startServeTunnel(input, AbortSignal.timeout(120_000)),
    stop: () => stopServeTunnel(AbortSignal.timeout(30_000)),
    notices: pageNotices,
    now: Date.now,
    onChange,
  });

/**
 * 一時共有の状態。共有はサービスの稼働と独立に続くので、サービスの状態には条件づけず、この hook を
 * mount している間 4 秒で取る (チャットは会話を開いている間、設定 → ランタイムは画面を開いている間)。
 */
export function useServeTunnel(): ServeTunnelHandle {
  const { state, controller } = useRuntimePolling(INITIAL_SERVE_TUNNEL_STATE, createController);
  const notice = useSyncExternalStore(pageNotices.subscribe, pageNotices.get, pageNotices.get);
  const start = useCallback(
    async (input: ServeTunnelStartBody): Promise<ServeTunnelStartResult> =>
      (await controller.current?.start(input)) ?? { kind: "cancelled" },
    [controller],
  );
  const stop = useCallback(async () => {
    await controller.current?.stop();
  }, [controller]);
  const resume = useCallback(async () => {
    await controller.current?.refresh({ force: true });
  }, [controller]);
  useEffect(() => pageReload.join(resume), [resume]);
  return { state, notice, start, stop, reload: pageReload.reload, dismissNotice: pageNotices.dismiss };
}
