import { useCallback } from "react";
import { getRuntimeDebugServeStatus, stopRuntimeDebugServe } from "../api";
import type { ConfirmFn } from "../components/ConfirmProvider";
import {
  createRuntimeDebugServeController,
  INITIAL_RUNTIME_DEBUG_SERVE_STATE,
  type RuntimeDebugServeState,
} from "../lib/runtimeDebugServe";
import { useRuntimePolling } from "./useRuntimePolling";

const createController = (confirm: ConfirmFn, onChange: (state: RuntimeDebugServeState) => void) =>
  createRuntimeDebugServeController({
    getStatus: () => getRuntimeDebugServeStatus(AbortSignal.timeout(15_000)),
    stop: (input) => stopRuntimeDebugServe(input, AbortSignal.timeout(30_000)),
    confirm,
    onChange,
  });

/**
 * 設定 → ランタイム のデバッグ節が使う、デバッグ用 serve の一覧。mount の間だけ 4 秒で回す。
 * 公開カードとは別に取得し、失敗もこの節の中だけで見せる。
 */
export function useRuntimeDebugServe() {
  const { state, refresh, controller } = useRuntimePolling(INITIAL_RUNTIME_DEBUG_SERVE_STATE, createController);
  const stop = useCallback(
    async (port: number) => {
      await controller.current?.stop(port);
    },
    [controller],
  );
  return { ...state, refresh, stop };
}
