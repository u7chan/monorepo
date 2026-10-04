import { useCallback, useEffect, useRef, useState } from "react";
import { getRuntimeServeStatus, stopRuntimeServe } from "../api";
import { useConfirm } from "../components/ConfirmProvider";
import { createRuntimeServeController, INITIAL_RUNTIME_SERVE_STATE } from "../lib/runtimeServe";

export function useRuntimeServe() {
  const confirm = useConfirm();
  const [state, setState] = useState(INITIAL_RUNTIME_SERVE_STATE);
  const controller = useRef<ReturnType<typeof createRuntimeServeController> | null>(null);
  useEffect(() => {
    const current = createRuntimeServeController({
      getStatus: () => getRuntimeServeStatus(AbortSignal.timeout(15_000)),
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
  const stop = useCallback(async () => {
    await controller.current?.stop();
  }, []);
  return { ...state, refresh, stop };
}
