import type { RuntimeServeStatus } from "../types";
import type { ConfirmRequest } from "./confirmDialog";

export interface RuntimeServeState {
  status: RuntimeServeStatus | null;
  loading: boolean;
  /**
   * 起動の確認待ちの対象 (会話 id)。確認ダイアログから起動の応答までの遷移状態で、
   * 起動していないときは null。全体で 1 件だけ持つ (公開枠が 1 本のため)。
   */
  starting: string | null;
  stopping: boolean;
  error?: string;
  failed: boolean;
}

export const INITIAL_RUNTIME_SERVE_STATE: RuntimeServeState = {
  status: null,
  loading: true,
  starting: null,
  stopping: false,
  failed: false,
};

/**
 * 起動の結果。状態の適用は成功時だけ行う。失敗は理由を持ち帰り、呼び出し側が対象の行に出す
 * (どの会話の起動に失敗したかは呼び出し側しか知らないため、共有の state.error には載せない)。
 */
export type RuntimeServeStartResult = { kind: "started" } | { kind: "cancelled" } | { kind: "failed"; error: string };

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
  start: (input: { sessionId: string; generation: string | null }) => Promise<RuntimeServeStatus>;
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
    if (!active || inFlight || state.stopping || state.starting !== null) return;
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
    /**
     * 起動。確認を取ってから、表示中の状態の世代を付けて送る。成功で状態を適用し、失敗 (409 を含む) は
     * 理由を残して状態を取り直すだけで、確認済みの世代での自動再試行はしない。
     */
    start: async (input: { sessionId: string; confirm: ConfirmRequest }): Promise<RuntimeServeStartResult> => {
      if (!active || state.stopping || state.starting !== null) return { kind: "cancelled" };
      const generation = state.status?.generation ?? null;
      revision += 1;
      update({ starting: input.sessionId, error: undefined });
      // 成功した応答は起動の結果そのものなので、直後の取得で上書きしない (サーバー側のキャッシュが古い値を返し得る)
      let refetch = true;
      try {
        if (!(await deps.confirm(input.confirm)) || !active) return { kind: "cancelled" };
        const next = await deps.start({ sessionId: input.sessionId, generation });
        update({ status: next, failed: false, loading: false });
        refetch = false;
        return { kind: "started" };
      } catch (error) {
        return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
      } finally {
        update({ starting: null });
        // 取り消し・409 の後も、確認済みの世代で自動再試行はせず状態だけ取り直す
        if (refetch) void refresh();
      }
    },
    stop: async () => {
      const status = state.status;
      if (!active || state.stopping || state.starting !== null || !status?.reachable || !status.generation) return;
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
