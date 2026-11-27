import { useCallback, useEffect, useRef, useState } from "react";
import { useConfirm, type ConfirmFn } from "../components/ConfirmProvider";

/** サービス状態を取り直す間隔。この hook を mount している間だけ回す */
const POLL_INTERVAL_MS = 4_000;

/** ポーリングする controller。`dispose` の後は状態を 1 つも通知しない */
export type RuntimePolledController = {
  refresh: () => Promise<void>;
  dispose: () => void;
};

/**
 * サービス状態のポーリングの mount と破棄。controller は mount の間だけ作り、初回と
 * `POLL_INTERVAL_MS` ごとの取得を回し、unmount で interval と controller を片付ける。
 */
export function useRuntimePolling<TState, TController extends RuntimePolledController>(
  initial: TState,
  create: (confirm: ConfirmFn, onChange: (state: TState) => void) => TController,
) {
  const confirm = useConfirm();
  const [state, setState] = useState(initial);
  const controller = useRef<TController | null>(null);
  useEffect(() => {
    const current = create(confirm, setState);
    controller.current = current;
    void current.refresh();
    const timer = setInterval(() => void current.refresh(), POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      current.dispose();
      controller.current = null;
    };
  }, [confirm, create]);
  const refresh = useCallback(async () => {
    await controller.current?.refresh();
  }, []);
  return { state, refresh, controller };
}
