import { useCallback, useEffect, useRef, useState } from "react";
import { getRuntimeDebugServeStatus, stopRuntimeDebugServe } from "../api";
import { useConfirm } from "../components/ConfirmProvider";
import { createRuntimeDebugServeController, INITIAL_RUNTIME_DEBUG_SERVE_STATE } from "../lib/runtimeDebugServe";

export function useRuntimeDebugServe() {
  const confirm = useConfirm();
  const [state, setState] = useState(INITIAL_RUNTIME_DEBUG_SERVE_STATE);
  const controller = useRef<ReturnType<typeof createRuntimeDebugServeController> | null>(null);
  useEffect(() => {
    const current = createRuntimeDebugServeController({
      getStatus: () => getRuntimeDebugServeStatus(AbortSignal.timeout(15_000)),
      stop: (input) => stopRuntimeDebugServe(input, AbortSignal.timeout(30_000)),
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
  const stop = useCallback(async (port: number) => {
    await controller.current?.stop(port);
  }, []);
  return { ...state, refresh, stop };
}
