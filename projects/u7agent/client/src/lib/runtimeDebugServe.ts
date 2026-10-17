import type { RuntimeDebugServeEntry, RuntimeDebugServeStatus } from "../types";
import type { ConfirmRequest } from "./confirmDialog";
import { messageFullTimeLabel } from "./messageTime";

/** デバッグ用 serve の一覧。公開カードとは別に取得し、失敗もデバッグ節の中だけで見せる */
export interface RuntimeDebugServeState {
  status: RuntimeDebugServeStatus | null;
  loading: boolean;
  /** 停止を確認・実行中の待受ポート。二重操作を無効にする */
  stoppingPort: number | null;
  error?: string;
  failed: boolean;
}

export const INITIAL_RUNTIME_DEBUG_SERVE_STATE: RuntimeDebugServeState = {
  status: null,
  loading: true,
  stoppingPort: null,
  failed: false,
};

/**
 * 確認ダイアログは一覧の値だけで組む (PID / 開始時刻を取り直す fd 走査を一覧 API に要求しない)。
 * `startedAt` を持つのは lease が残っている行だけで、追跡外の行には出さない。
 */
export function runtimeDebugServeStopConfirm(entry: RuntimeDebugServeEntry): ConfirmRequest {
  const owner = entry.owner;
  const notes = [
    ...(owner ? [`起動元の会話: ${owner.title || "無題のセッション"}`] : []),
    ...(entry.startedAt === null ? [] : [`起動時刻: ${messageFullTimeLabel(entry.startedAt)}`]),
  ];
  return {
    kind: "confirm",
    title: "デバッグ用サーバーを停止",
    body: [
      "エージェントの自己デバッグ用サーバーを強制停止します。会話やエージェントの実行は停止しません。",
      owner
        ? `いま ${entry.port} 番ポートで待ち受けているプロセスを停止します。起動時と入れ替わっていれば停止しません。`
        : `起動元は追跡できていません。いま ${entry.port} 番ポートで待ち受けているプロセスを停止します。`,
    ],
    subject: { label: "待受ポート（サンドボックス側）", value: String(entry.port) },
    ...(notes.length === 0 ? {} : { notes }),
    ...(entry.command ? { code: { label: "起動コマンド", value: entry.command } } : {}),
    confirmLabel: "強制停止する",
    danger: true,
  };
}

/** ポーリングと停止の遅い応答が、停止後の一覧や画面を閉じた後の state を上書きしないようにする。 */
export function createRuntimeDebugServeController(deps: {
  getStatus: () => Promise<RuntimeDebugServeStatus>;
  stop: (input: { port: number }) => Promise<unknown>;
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  onChange: (state: RuntimeDebugServeState) => void;
}) {
  let state = INITIAL_RUNTIME_DEBUG_SERVE_STATE;
  let active = true;
  let inFlight = false;
  let revision = 0;
  const update = (patch: Partial<RuntimeDebugServeState>) => {
    if (!active) return;
    state = { ...state, ...patch };
    deps.onChange(state);
  };
  const refresh = async () => {
    if (!active || inFlight || state.stoppingPort !== null) return;
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
    stop: async (port: number) => {
      const entry = state.status?.servers.find((server) => server.port === port);
      if (!active || state.stoppingPort !== null || !entry) return;
      revision += 1;
      update({ stoppingPort: port, error: undefined });
      try {
        if (!(await deps.confirm(runtimeDebugServeStopConfirm(entry))) || !active) return;
        await deps.stop({ port });
        // 一覧はサーバーの取り直しで置き換える (取得の失敗は停止の失敗にせず、次のポーリングが failed として出す)
        const status = await deps.getStatus().catch(() => null);
        if (status) update({ status, failed: false, loading: false });
      } catch (error) {
        update({ error: error instanceof Error ? error.message : String(error) });
      } finally {
        update({ stoppingPort: null });
        // 取消や失敗の後も、確認した port で自動再試行はせず状態だけ取り直す。
        void refresh();
      }
    },
    dispose: () => {
      active = false;
      revision += 1;
    },
  };
}
