/**
 * 一時共有の画面の純関数とコントローラー。契約は docs/service-tunnel.md の「画面」。
 * 状態名・終了の理由・期限の値の正は server の service-tunnel.ts と schema/ で、ここへ一覧を写さない。
 */
import type {
  RuntimeServeStatus,
  ServeTunnelActive,
  ServeTunnelEndReason,
  ServeTunnelLastEnded,
  ServeTunnelStartBody,
  ServeTunnelStatus,
  ServeTunnelTarget,
  ServeTunnelTtlMinutes,
} from "../types";
import { apiFailureStatus, messageFor } from "./errors";
import { createRuntimePoller, type RuntimePolledState } from "./runtimePoller";

export const SERVE_TUNNEL_TTL_OPTIONS: readonly { value: ServeTunnelTtlMinutes; label: string }[] = [
  { value: 15, label: "15 分" },
  { value: 60, label: "1 時間" },
  { value: 180, label: "3 時間" },
];
export const DEFAULT_SERVE_TUNNEL_TTL: ServeTunnelTtlMinutes = 60;

export const SERVE_TUNNEL_NOTICE_SUMMARY =
  "URL を知っていれば誰でも開けます。開発サーバーの内容が見えることがあります。";
export const SERVE_TUNNEL_NOTICE_ITEMS: readonly string[] = [
  "URL を知っていれば、期限まで誰でもサービスを開けます。URL は共有のたびに変わります。",
  "開発サーバーは、ソース・エラーの詳細・渡した環境変数を応答に含むことがあります。",
  "SSE は使えず、WebSocket（HMR）は通りません。同時に 200 を超えるリクエストは 429 になります。",
  "アプリが自分で再起動すると、共有が終わることがあります。",
  "稼働の保証は無く、Cloudflare の利用規約の対象です。",
];

const UNKNOWN = "不明";
const UNTITLED = "無題のセッション";
const START_FAILED = "共有を開始できませんでした。接続を確認して、もう一度お試しください。";
const FAILED_FALLBACK = "共有を開始できませんでした。時間を置いてから再試行してください。";
const END_TEXT = {
  expired: "共有の期限が切れました。URL は無効になりました。",
  replaced: "公開中のサービスが入れ替わったため、共有を終了しました。URL は無効になりました。",
  exited: "共有の接続が予期せず終了しました。URL は無効になりました。",
} as const;

/** 確認に出す対象と、開始に必須の世代。確認を表示した時点の値で、開始まで差し替えない */
export interface ServeShareCandidate {
  generation: string;
  target: ServeTunnelTarget;
}

/** 設定 → ランタイムの状態から。誰が起動したアプリでも対象で、起動元が分からなければ null のまま残す */
export function runtimeShareCandidate(status: RuntimeServeStatus | null): ServeShareCandidate | null {
  if (!status?.reachable || !status.generation) return null;
  return {
    generation: status.generation,
    target: {
      title: status.owner === null ? null : status.owner.title,
      cwd: status.command === null ? null : status.command.cwd,
      command: status.command === null ? null : status.command.command,
    },
  };
}

/** 開始が 409 で断られたときだけ、最新の対象で確認し直す。他の失敗は、見せた内容のまま再試行させる */
export function nextShareConfirmation(
  confirmed: ServeShareCandidate | null,
  live: ServeShareCandidate | null,
  result: ServeTunnelStartResult,
): ServeShareCandidate | null {
  return result.kind === "failed" && result.conflict ? live : confirmed;
}

/**
 * 見せた確認と、いまの対象が食い違うか。食い違う間は、見せた内容を黙って差し替えず、開始も止める。
 * 利用者が最新の内容で確認し直すまで、確認していないアプリを共有させないため。
 */
export function isShareConfirmationStale(
  confirmed: ServeShareCandidate | null,
  live: ServeShareCandidate | null,
): boolean {
  return (confirmed?.generation ?? null) !== (live?.generation ?? null);
}

export interface ServeTunnelTargetRow {
  label: string;
  value: string;
  mono: boolean;
}

export function serveTunnelTargetRows(target: ServeTunnelTarget): ServeTunnelTargetRow[] {
  return [
    { label: "起動元の会話", value: target.title === null ? UNKNOWN : target.title || UNTITLED, mono: false },
    { label: "作業ディレクトリ", value: target.cwd === null ? UNKNOWN : target.cwd || ".", mono: true },
    { label: "起動コマンド", value: target.command ?? UNKNOWN, mono: true },
  ];
}

/** 分単位。切り上げるので、15 分で始めた直後は「残り 15 分」になる。1 分未満と期限切れは同じ文言 */
export function serveTunnelRemaining(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms < 60_000) return "まもなく終了";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `残り ${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `残り ${hours} 時間` : `残り ${hours} 時間 ${rest} 分`;
}

export interface ServeTunnelNotice {
  /** `lastEnded.at`。通知の鍵 */
  at: number;
  reason: Exclude<ServeTunnelEndReason, "stopped">;
  text: string;
}

function endNotice(ended: ServeTunnelLastEnded): ServeTunnelNotice | null {
  if (ended.reason === "stopped") return null;
  const text = ended.reason === "failed" ? (ended.message ?? FAILED_FALLBACK) : END_TEXT[ended.reason];
  return { at: ended.at, reason: ended.reason, text };
}

/** ダイアログが同じ開始の失敗を表示中なら、終了の通知は重ねない (閉じたあとに同じ文言が残らない) */
export function isShownStartFailure(notice: ServeTunnelNotice | null, failure: string | undefined): boolean {
  return notice !== null && notice.reason === "failed" && failure !== undefined && notice.text === failure;
}

export interface ServeTunnelNotices {
  observe: (status: ServeTunnelStatus) => void;
  dismiss: () => void;
  get: () => ServeTunnelNotice | null;
  subscribe: (listener: () => void) => () => void;
}

/**
 * 終了の通知の台帳。`lastEnded` はサーバーに次の開始まで残るので、最初の取得に残っていた終了は出さず、
 * それより新しい `at` だけを 1 回出す。サーバーの時刻だけで比べ、端末の時計のずれを持ち込まない。
 */
export function createServeTunnelNotices(): ServeTunnelNotices {
  let newest: number | null = null;
  let current: ServeTunnelNotice | null = null;
  const listeners = new Set<() => void>();
  const set = (next: ServeTunnelNotice | null): void => {
    if (current === next) return;
    current = next;
    for (const listener of listeners) listener();
  };
  return {
    observe(status) {
      newest ??= status.lastEnded?.at ?? 0;
      // 新しい共有が始まったら、前の終了の通知は役目を終える
      if (status.state !== "idle") return set(null);
      const ended = status.lastEnded;
      if (ended === null || ended.at <= newest) return;
      newest = ended.at;
      const notice = endNotice(ended);
      if (notice !== null) set(notice);
    },
    dismiss: () => set(null),
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export interface ServeTunnelPolled extends RuntimePolledState<ServeTunnelStatus> {
  starting: boolean;
  stopping: boolean;
  stopError: string | undefined;
}

export interface ServeTunnelState extends ServeTunnelPolled {
  /** 最後に取得できた状態。取得に失敗しても消さず、共有中の表示と停止を残す */
  known: ServeTunnelStatus | null;
  /** この state を公開した時刻。残り時間の基準で、描画中に時計を読まない */
  observedAt: number;
}

const INITIAL_POLLED: ServeTunnelPolled = {
  status: null,
  loading: true,
  failed: false,
  starting: false,
  stopping: false,
  stopError: undefined,
};
export const INITIAL_SERVE_TUNNEL_STATE: ServeTunnelState = { ...INITIAL_POLLED, known: null, observedAt: 0 };

export type ServeTunnelStartResult =
  | { kind: "started" }
  | { kind: "cancelled" }
  | { kind: "failed"; error: string; conflict: boolean };

/** 利用不可が確定していて共有も無い間は、取得しても変わらないので省く。再読み込みで再開する */
export function shouldSkipServeTunnelFetch(status: ServeTunnelStatus | null): boolean {
  return status !== null && !status.available && status.state === "idle";
}

/**
 * 開始 / 停止の応答は状態として適用し、先に発行した取得の遅い応答で上書きしない。開始の最中の停止は
 * 開始を中断するので、その開始の応答は適用せず、中断を失敗として見せない。
 */
export function createServeTunnelController(deps: {
  getStatus: () => Promise<ServeTunnelStatus>;
  start: (input: ServeTunnelStartBody) => Promise<ServeTunnelStatus>;
  stop: () => Promise<ServeTunnelStatus>;
  notices: ServeTunnelNotices;
  now: () => number;
  onChange: (state: ServeTunnelState) => void;
}) {
  let known: ServeTunnelStatus | null = null;
  let observed: ServeTunnelStatus | null = null;
  let startSuperseded = false;
  const poller = createRuntimePoller<ServeTunnelStatus, ServeTunnelPolled>({
    initial: INITIAL_POLLED,
    isBusy: (state) => state.starting || state.stopping,
    fetchStatus: deps.getStatus,
    onChange: (state) => {
      if (state.status !== null) known = state.status;
      if (state.status !== null && state.status !== observed) {
        observed = state.status;
        deps.notices.observe(state.status);
      }
      deps.onChange({ ...state, known, observedAt: deps.now() });
    },
  });
  const apply = (status: ServeTunnelStatus): void => poller.update({ status, failed: false, loading: false });

  return {
    refresh: (options: { force?: boolean } = {}): Promise<void> =>
      options.force !== true && shouldSkipServeTunnelFetch(poller.state().status)
        ? Promise.resolve()
        : poller.refresh(),
    start: async (input: ServeTunnelStartBody): Promise<ServeTunnelStartResult> => {
      const current = poller.state();
      if (!poller.isActive() || current.starting || current.stopping) return { kind: "cancelled" };
      startSuperseded = false;
      deps.notices.dismiss();
      poller.begin({ starting: true, stopError: undefined });
      // 成功の応答は開始の結果そのものなので、直後の取得で上書きしない (サーバー側の判定は古い値を返し得る)
      let applied = false;
      try {
        const next = await deps.start(input);
        if (startSuperseded || !poller.isActive()) return { kind: "cancelled" };
        apply(next);
        applied = true;
        return next.state === "active" ? { kind: "started" } : { kind: "cancelled" };
      } catch (error) {
        if (startSuperseded || !poller.isActive()) return { kind: "cancelled" };
        const status = apiFailureStatus(error);
        return {
          kind: "failed",
          error: status === undefined ? START_FAILED : messageFor(error),
          conflict: status === 409,
        };
      } finally {
        poller.update({ starting: false });
        if (!applied) void poller.refresh();
      }
    },
    // 確認は挟まない。止める操作は冪等で安全なので、状態の取得に失敗している間も押せる
    stop: async (): Promise<void> => {
      const current = poller.state();
      if (!poller.isActive() || current.stopping) return;
      if (current.starting) startSuperseded = true;
      poller.begin({ stopping: true, stopError: undefined });
      try {
        apply(await deps.stop());
      } catch (error) {
        poller.update({ stopError: messageFor(error) });
      } finally {
        poller.update({ stopping: false });
        void poller.refresh();
      }
    },
    dispose: poller.dispose,
  };
}

/** 画面が読む共有の取り口。hook の戻り値で、コンポーネントのテストは同じ形の値を直接渡す */
export interface ServeTunnelHandle {
  state: ServeTunnelState;
  notice: ServeTunnelNotice | null;
  start: (input: ServeTunnelStartBody) => Promise<ServeTunnelStartResult>;
  stop: () => Promise<void>;
  reload: () => Promise<void>;
  dismissNotice: () => void;
}

export type ServeTunnelPhase = "unknown" | "unavailable" | "idle" | "starting" | "active";

export interface ServeTunnelView {
  phase: ServeTunnelPhase;
  /** 共有中 (準備中を含む)。表示と停止はサービスの状態に関係なく出す */
  sharing: boolean;
  active: ServeTunnelActive | null;
  /** 「共有中・残り 52 分」。共有中でなければ null */
  badge: string | null;
  /** 「残り 52 分」。active のときだけ */
  remaining: string | null;
  /** 準備中の停止は開始の中断 */
  stopLabel: string;
  /** 利用できない理由。phase が unavailable のときだけ */
  unavailableReason: string | null;
  /** 最新の状態を取得できていない。表示は最後に取得できた状態 */
  stale: boolean;
}

function phaseOf(state: ServeTunnelState): ServeTunnelPhase {
  if (state.starting) return "starting";
  const known = state.known;
  if (known === null) return "unknown";
  if (known.state === "starting") return "starting";
  if (known.state === "active" && known.active !== null) return "active";
  return known.available ? "idle" : "unavailable";
}

export function serveTunnelView(state: ServeTunnelState): ServeTunnelView {
  const phase = phaseOf(state);
  const active = phase === "active" ? (state.known?.active ?? null) : null;
  const remaining = active === null ? null : serveTunnelRemaining(active.expiresAt, state.observedAt);
  const sharing = phase === "starting" || phase === "active";
  return {
    phase,
    sharing,
    active,
    badge: phase === "starting" ? "共有を準備中…" : remaining === null ? null : `共有中・${remaining}`,
    remaining,
    stopLabel: phase === "starting" ? "準備を中断" : "共有を停止",
    unavailableReason: phase === "unavailable" ? (state.known?.unavailableReason ?? null) : null,
    stale: state.failed && state.known !== null,
  };
}

export function serveTunnelStopErrorText(error: string | undefined): string | undefined {
  const text = error?.trim();
  return text ? `共有を停止できませんでした: ${text}` : undefined;
}

/** 入口 (チャットのバー・設定 → ランタイム) が描く、共有の表示と操作 */
export interface ServeTunnelEntry {
  view: ServeTunnelView;
  notice: ServeTunnelNotice | null;
  stopping: boolean;
  error: string | undefined;
  onOpen: () => void;
  onStop: () => void;
  onDismissNotice: () => void;
}

export function serveTunnelEntry(handle: ServeTunnelHandle, onOpen: () => void): ServeTunnelEntry {
  return {
    view: serveTunnelView(handle.state),
    notice: handle.notice,
    stopping: handle.state.stopping,
    error: serveTunnelStopErrorText(handle.state.stopError),
    onOpen,
    onStop: () => void handle.stop(),
    onDismissNotice: handle.dismissNotice,
  };
}
