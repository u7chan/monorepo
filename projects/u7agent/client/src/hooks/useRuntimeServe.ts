import { useCallback, useEffect, useRef, useState } from "react";
import { getRuntimeServeStatus, startRuntimeServe, stopRuntimeServe } from "../api";
import { useConfirm } from "../components/ConfirmProvider";
import {
  createRuntimeServeController,
  INITIAL_RUNTIME_SERVE_STATE,
  type RuntimeServeStartResult,
} from "../lib/runtimeServe";
import type { ConfirmRequest } from "../lib/confirmDialog";

/**
 * 設定 → ランタイム と実行状況が使う、全スペース共通のサービス状態。この hook が mount されている
 * 間だけ 4 秒で回す (実行状況は `/activity` を表示している間だけ mount される)。
 */
export function useRuntimeServe() {
  const confirm = useConfirm();
  const [state, setState] = useState(INITIAL_RUNTIME_SERVE_STATE);
  const controller = useRef<ReturnType<typeof createRuntimeServeController> | null>(null);
  useEffect(() => {
    const current = createRuntimeServeController({
      getStatus: () => getRuntimeServeStatus(AbortSignal.timeout(15_000)),
      start: (input) => startRuntimeServe(input, AbortSignal.timeout(30_000)),
      stop: (input) => stopRuntimeServe(input, AbortSignal.timeout(30_000)),
      confirm,
      onChange: setState,
    });
    controller.current = current;
    void current.refresh();
    const timer = setInterval(() => void current.refresh(), 4_000);
    return () => {
      clearInterval(timer);
      current.dispose();
      controller.current = null;
    };
  }, [confirm]);
  const refresh = useCallback(async () => {
    await controller.current?.refresh();
  }, []);
  const start = useCallback(
    async (input: { sessionId: string; confirm: ConfirmRequest }): Promise<RuntimeServeStartResult> =>
      (await controller.current?.start(input)) ?? { kind: "cancelled" },
    [],
  );
  const stop = useCallback(async () => {
    await controller.current?.stop();
  }, []);
  return { ...state, refresh, start, stop };
}
