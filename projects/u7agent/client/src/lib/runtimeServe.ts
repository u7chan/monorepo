import type { RuntimeServeStatus } from "../types";
import type { ConfirmRequest } from "./confirmDialog";

export interface RuntimeServeState {
  status: RuntimeServeStatus | null;
  loading: boolean;
  stopping: boolean;
  error?: string;
  failed: boolean;
}

export const INITIAL_RUNTIME_SERVE_STATE: RuntimeServeState = {
  status: null,
  loading: true,
  stopping: false,
  failed: false,
};

export function runtimeServeStopConfirm(status: RuntimeServeStatus): ConfirmRequest {
  return {
    kind: "confirm",
    title: "サービスを停止",
    body: ["現在公開中のサーバーを停止します。会話やエージェントの実行は停止しません。"],
    subject: {
      label: "起動元の会話",
      value: status.owner?.title || (status.owner ? "無題のセッション" : "起動元不明"),
    },
    ...(status.command ? { code: { label: "起動コマンド", value: status.command.command } } : {}),
    confirmLabel: "停止する",
    danger: true,
  };
}

/** ポーリングと停止の遅い応答が、停止後の状態や画面を閉じた後の state を上書きしないようにする。 */
export function createRuntimeServeController(deps: {
  getStatus: () => Promise<RuntimeServeStatus>;
  stop: (input: { generation: string }) => Promise<RuntimeServeStatus>;
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  onChange: (state: RuntimeServeState) => void;
}) {
  let state = INITIAL_RUNTIME_SERVE_STATE;
  let active = true;
  let inFlight = false;
  let revision = 0;
  const update = (patch: Partial<RuntimeServeState>) => {
    if (!active) return;
    state = { ...state, ...patch };
    deps.onChange(state);
  };
  const refresh = async () => {
    if (!active || inFlight || state.stopping) return;
    inFlight = true;
    const issued = revision;
    try {
      const status = await deps.getStatus();
      if (issued !== revision) return;
      update({ status, loading: false, failed: false });
    } catch {
      if (issued !== revision) return;
      update({ status: null, loading: false, failed: true });
    } finally {
      inFlight = false;
    }
  };
  return {
    refresh,
    stop: async () => {
      const status = state.status;
      if (!active || state.stopping || !status?.reachable || !status.generation) return;
      const generation = status.generation;
      revision += 1;
      update({ stopping: true, error: undefined });
      try {
        if (!(await deps.confirm(runtimeServeStopConfirm(status))) || !active) return;
        const next = await deps.stop({ generation });
        update({ status: next, failed: false, loading: false });
      } catch (error) {
        update({ status: null, error: error instanceof Error ? error.message : String(error) });
      } finally {
        update({ stopping: false });
        // 取消や 409 の後も、確認済みの世代で自動再試行はせず状態だけ取り直す。
        void refresh();
      }
    },
    dispose: () => {
      active = false;
      revision += 1;
    },
  };
}
