/**
 * サービスの状態表示 (トップバー) の純関数。表示の条件はこの module と client/test/servedApp.test.ts が正で、
 * 採用しなかった案と理由は docs/sandbox.md#serveサービスの公開と起動停止 が持つ (描画と API 呼び出しは component / hook)。
 */
import type { RunStatus, ServeStatus, SessionSummary } from "../types";
import type { ConfirmRequest } from "./confirmDialog";
import { publicOrigin } from "./publicOrigin";
import type { ServeShareCandidate } from "./serveTunnel";

/**
 * サービスを開く URL。公開オリジン (TLS 終端の後ろでは scheme が変わる) があればそれを優先し、
 * 未設定・壊れた値なら現行どおり hostname と health のポートから組む。
 */
export function servedAppUrl(hostname: string, port: number | undefined, origin?: string): string | undefined {
  const base = publicOrigin(origin);
  if (base !== undefined) return `${base}/`;
  if (!hostname || port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return `http://${hostname}:${port}/`;
}

/**
 * `<a target="_blank">` をプログラム的にクリックして別タブで開く (ポップオーバーの項目は button のため)。
 * Firefox は document に繋がっていない要素の click を無視するので、押す間だけ append する。
 */
export function openServedApp(url: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noreferrer noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/** 表の 5 行に対応する見え方。none は何も出さない */
export type ServeViewKind = "none" | "running" | "stopped" | "other" | "unknown";

export type ServeBusyKind = "self" | "other";

export function servedAppBusyKind({
  selfStatus,
  sessionId,
  projectId,
  sessions,
}: {
  selfStatus: RunStatus;
  sessionId: string;
  projectId?: string;
  sessions: readonly Pick<SessionSummary, "sessionId" | "projectId" | "status">[];
}): ServeBusyKind | undefined {
  const isBusy = (status: RunStatus) => status === "running" || status === "queued";
  if (isBusy(selfStatus)) return "self";
  if (
    projectId &&
    sessions.some(
      (session) => session.sessionId !== sessionId && session.projectId === projectId && isBusy(session.status),
    )
  ) {
    return "other";
  }
  return undefined;
}

export interface ServeView {
  kind: ServeViewKind;
  /** 状態バッジのラベル */
  label: string;
  /** 色の出し分け (ok = 緑 / idle = 灰 / warn = 橙) */
  tone: "ok" | "idle" | "warn";
  /** 稼働中だけサービスリンクを出す */
  canOpen: boolean;
  canStop: boolean;
  canStart: boolean;
  /** この会話が起動したアプリだけ、一時共有を始められる (他の会話・起動元不明は設定 → ランタイムから) */
  canShare: boolean;
  /** 状態の根拠 (バッジの title) */
  badgeTitle: string;
  /** singleColumn の読み上げ名 */
  ariaLabel: string;
  /** 起動の実績 (閲覧中の会話の作業ディレクトリのコマンド) */
  command?: string;
  cwd?: string;
  /** 他会話が公開中のときの会話名 */
  ownerTitle?: string;
}

const NONE: ServeView = {
  kind: "none",
  label: "",
  tone: "idle",
  canOpen: false,
  canStop: false,
  canStart: false,
  canShare: false,
  badgeTitle: "",
  ariaLabel: "",
};

/**
 * 状態から見え方を決める。取得失敗 (status なし) と実績なしは同じ「何も出さない」だが、
 * 呼び出し側は前者でリンクも操作も出さない (到達不可と区別する)。
 */
export function servedAppView(status: ServeStatus | null | undefined): ServeView {
  if (!status) return NONE;
  const command = status.command?.command;
  const cwd = status.command?.cwd;
  const base = { command, cwd };
  if (status.reachable && status.owner.kind === "mine") {
    return {
      ...base,
      kind: "running",
      label: "稼働中",
      tone: "ok",
      canOpen: true,
      canStop: true,
      canStart: false,
      canShare: true,
      badgeTitle: "この会話のサービスが公開されています",
      ariaLabel: "サービスは稼働中。メニューを開く",
    };
  }
  if (status.reachable && status.owner.kind === "other" && command) {
    return {
      ...base,
      kind: "other",
      label: "停止中",
      tone: "idle",
      canOpen: false,
      canStop: false,
      canStart: true,
      canShare: false,
      ownerTitle: status.owner.title,
      badgeTitle: "別の会話のサービスが公開されています",
      ariaLabel: "サービスは停止中。メニューを開く",
    };
  }
  if (status.reachable && status.owner.kind === "unknown" && command) {
    return {
      ...base,
      kind: "unknown",
      label: "停止中（起動元不明）",
      tone: "warn",
      canOpen: false,
      canStop: true,
      canStart: true,
      canShare: false,
      badgeTitle: "記録と一致しないプロセスが使用中です",
      ariaLabel: "サービスは停止中（起動元不明）。メニューを開く",
    };
  }
  if (!status.reachable && command) {
    return {
      ...base,
      kind: "stopped",
      label: "停止中",
      tone: "idle",
      canOpen: false,
      canStop: false,
      canStart: true,
      canShare: false,
      badgeTitle: "この会話の作業ディレクトリには起動の実績があります",
      ariaLabel: "サービスを起動",
    };
  }
  return NONE;
}

/** チャットの入口が確認に出す対象。共有を始められるのは、この会話が起動したアプリだけ */
export function servedAppShareCandidate(status: ServeStatus | null | undefined): ServeShareCandidate | null {
  if (!status?.generation || !servedAppView(status).canShare) return null;
  return {
    generation: status.generation,
    target: {
      title: status.owner.title ?? null,
      cwd: status.command?.cwd ?? null,
      command: status.command?.command ?? null,
    },
  };
}

/** singleColumn のメニュー先頭に出す補足 (状態の根拠)。1 行に収める */
export function servedAppMenuSub(view: ServeView): string {
  if (view.kind === "other") {
    return view.ownerTitle ? `会話「${view.ownerTitle}」が公開中` : "別の会話が公開中";
  }
  if (view.kind === "unknown") return "記録と一致しないプロセスが使用中";
  if (!view.command) return "";
  return [view.cwd || ".", view.command].join(" · ");
}

/**
 * 置き換えの確認。所有者名は clamp した独立した行へ 1 回だけ出し、起動コマンドも等幅の別行にする
 * (文章へ埋めると 60 文字のタイトルで読めなくなる)。ボタンは何をするかを書く。
 */
export function servedAppStartConfirm(view: ServeView, busy: ServeBusyKind | undefined): ConfirmRequest | undefined {
  const replace = view.kind === "other" || view.kind === "unknown";
  const notes: string[] = [];
  if (busy === "self") {
    notes.push("エージェントが実行中です。編集途中のファイルを読み込んだ状態で起動します。");
  } else if (busy === "other") {
    notes.push("同じ作業フォルダの他会話でエージェントが実行中です。編集途中のファイルを読み込んだ状態で起動します。");
  }
  if (!replace && notes.length === 0) return undefined;
  return {
    kind: "confirm",
    title: "サービスを起動",
    body: replace
      ? [
          view.kind === "unknown"
            ? "起動元不明のプロセスを停止して、この会話のサービスを起動します。"
            : "他会話のサービスを停止して、この会話のサービスを起動します。",
        ]
      : [],
    ...(view.kind === "other" && view.ownerTitle ? { subject: { label: "停止する会話", value: view.ownerTitle } } : {}),
    ...(replace && view.command ? { code: { label: "起動コマンド", value: view.command } } : {}),
    ...(notes.length > 0 ? { notes } : {}),
    confirmLabel: replace ? "停止して起動" : "起動する",
    danger: replace,
  };
}

/** 置き換えの起動項目の説明文 (押す前の予告) */
export function servedAppReplaceHint(view: ServeView): string {
  if (view.kind === "stopped") return "この会話のサービスを起動";
  if (view.kind === "unknown") return "停止して置き換え";
  return view.ownerTitle ? `会話「${view.ownerTitle}」を停止して置き換え` : "停止して置き換え";
}

/**
 * メニュー項目の前に区切りを置くかどうか。破壊的な操作を色だけで示さないため、通常の操作と危険な操作の
 * 境界に 1 本置く (並びは変えない)。`RowMenu` の danger の区切りと同じ見た目にする。
 */
export function servedAppMenuSeparators(items: readonly { danger?: boolean }[]): boolean[] {
  return items.map((item, index) => index > 0 && (item.danger === true) !== (items[index - 1]?.danger === true));
}

/** 起動の失敗を表示する 1 行。押した後の遷移状態から戻したときに出す */
export function servedAppErrorText(error: string | undefined): string | undefined {
  const text = error?.trim();
  return text ? `サービスの操作に失敗しました: ${text}` : undefined;
}

/**
 * 起動の後にバー直下へ出す「開く」1 行のエピソード。行を出すのはエピソードごとに 1 回で、
 * ✕ はそのエピソードだけを閉じる (次のエピソードではまた出す)。
 */
export interface ServeRowState {
  /** 行を出すエピソードがあるか */
  episode: boolean;
  /**
   * 直前の確定状態。エピソードを立てる判定にだけ使い、取得に失敗しても消さない
   * (失敗は「到達不可」ではなく、そこで状態を見失っただけ)。初期取得 / 会話切替の直後は undefined。
   */
  settled?: ServeStatus;
}

/** エピソードの状態を動かす出来事。状態の確定 (start-ok / refreshed) と、観測が切れた合図を分ける */
export type ServeRowEvent =
  /** このタブの GUI 起動が成功した (適用した状態を持つ) */
  | { kind: "start-ok"; status: ServeStatus }
  /**
   * ポーリング / 停止の結果で状態が確定した。`starting` は確認待ち (起動の押下から応答まで) の
   * 最中に観測したか (観測の時点ではなく、適用した時点の値を渡す)
   */
  | { kind: "refreshed"; status: ServeStatus; starting: boolean }
  /** 起動の確認待ちへ入った (この時点でサービスはまだ到達可とは限らない) */
  | { kind: "starting" }
  /** 取得に失敗した (リンクも操作も出さない。到達不可と区別する) */
  | { kind: "failed" }
  /** 会話が変わった (前の会話の確定状態も捨てる) */
  | { kind: "session-changed" }
  /** ✕ で閉じた */
  | { kind: "dismissed" }
  /** 行から開いた */
  | { kind: "opened" };

export const NO_SERVE_ROW: ServeRowState = { episode: false };

/**
 * 出来事 1 つぶんのエピソードの遷移。稼働中のポーリングでは落とさず、観測の起点が切れたとき
 * (会話切替 / 取得失敗 / 確認待ち / 閉じた) に落とす。立てるのは起動成功と到達不可からの復帰だけ。
 */
export function servedAppRow(state: ServeRowState, event: ServeRowEvent): ServeRowState {
  switch (event.kind) {
    case "start-ok":
      return { episode: true, settled: event.status };
    case "refreshed": {
      const stands =
        !event.starting &&
        state.settled !== undefined &&
        !state.settled.reachable &&
        servedAppView(event.status).canOpen;
      // 確認待ち中の観測でも状態は記録する (確認待ちが解けたあとの到達可 → 到達可では立てない)
      return { episode: state.episode || stands, settled: event.status };
    }
    case "session-changed":
      return NO_SERVE_ROW;
    case "starting":
    case "failed":
    case "dismissed":
    case "opened":
      return { episode: false, settled: state.settled };
  }
}

/**
 * バー直下の「開く」1 行の href。エピソードがあり、取得に失敗せず、開けて URL を作れるときだけ
 * 描く (消える条件を並べないので、状態が増えても嘘のリンクを出さない)。
 */
export function servedAppRowHref({
  row,
  status,
  failed,
  hostname,
  port,
  origin,
}: {
  row: ServeRowState;
  status?: ServeStatus | null;
  failed: boolean;
  hostname: string;
  port?: number;
  origin?: string;
}): string | undefined {
  if (!row.episode || failed || !servedAppView(status).canOpen) return undefined;
  return servedAppUrl(hostname, port, origin);
}

/**
 * 起動成功時に desktop の「サービス」リンクへ焦点を移す要求。入力は必ず成功時点で読み、singleColumn
 * では立てない (残すと desktop へ戻ったときに古い要求で焦点が飛ぶ)。
 */
export function servedAppFocusRequest({
  applied,
  singleColumn,
  focusOnBody,
}: {
  /** このタブの起動が適用された (失敗 / 会話切替 / セッション未確定は false) */
  applied: boolean;
  /** 成功時点のレイアウトが singleColumn */
  singleColumn: boolean;
  /** 成功時点の焦点がどこにも無い (document.activeElement が body) */
  focusOnBody: boolean;
}): boolean {
  return applied && !singleColumn && focusOnBody;
}
