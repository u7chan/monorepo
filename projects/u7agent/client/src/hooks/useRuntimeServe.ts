import { useCallback } from "react";
import { getRuntimeServeStatus, startRuntimeServe, stopRuntimeServe } from "../api";
import type { ConfirmFn } from "../components/ConfirmProvider";
import type { ConfirmRequest } from "../lib/confirmDialog";
import {
  createRuntimeServeController,
  INITIAL_RUNTIME_SERVE_STATE,
  type RuntimeServeStartResult,
  type RuntimeServeState,
} from "../lib/runtimeServe";
import { useRuntimePolling } from "./useRuntimePolling";

const createController = (confirm: ConfirmFn, onChange: (state: RuntimeServeState) => void) =>
  createRuntimeServeController({
    getStatus: () => getRuntimeServeStatus(AbortSignal.timeout(15_000)),
    start: (input) => startRuntimeServe(input, AbortSignal.timeout(30_000)),
    stop: (input) => stopRuntimeServe(input, AbortSignal.timeout(30_000)),
    confirm,
    onChange,
  });

/**
 * 設定 → ランタイム と実行状況が使う、全スペース共通のサービス状態。この hook が mount されている
 * 間だけ 4 秒で回す (実行状況は `/activity` を表示している間だけ mount される)。
 */
export function useRuntimeServe() {
  const { state, refresh, controller } = useRuntimePolling(INITIAL_RUNTIME_SERVE_STATE, createController);
  const start = useCallback(
    async (input: { sessionId: string; confirm: ConfirmRequest }): Promise<RuntimeServeStartResult> =>
      (await controller.current?.start(input)) ?? { kind: "cancelled" },
    [controller],
  );
  const stop = useCallback(async () => {
    await controller.current?.stop();
  }, [controller]);
  return { ...state, refresh, start, stop };
}
