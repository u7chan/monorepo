/**
 * サービスの状態表示 (トップバー) の純関数。表示と操作は docs/ui-layout.md の表が正で、
 * ここは「どの状態をどう描くか」だけを決める (描画と API 呼び出しは component / hook が持つ)。
 */
import type { RunStatus, ServeStatus, SessionSummary } from "../types";
import type { ConfirmRequest } from "./confirmDialog";

export function servedAppUrl(hostname: string, port: number | undefined): string | undefined {
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
  /** 状態の根拠 (バッジの title) */
  badgeTitle: string;
  /** compact の読み上げ名 */
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
      badgeTitle: "この会話の作業ディレクトリには起動の実績があります",
      ariaLabel: "サービスを起動",
    };
  }
  return NONE;
}

/** compact のメニュー先頭に出す補足 (状態の根拠)。1 行に収める */
export function servedAppMenuSub(view: ServeView): string {
  if (view.kind === "other") {
    return view.ownerTitle ? `会話「${view.ownerTitle}」が公開中` : "別の会話が公開中";
  }
  if (view.kind === "unknown") return "記録と一致しないプロセスが使用中";
  if (!view.command) return "";
  return [view.cwd || ".", view.command].join(" · ");
}

/**
 * 置き換えの確認。押す前にメニューの説明文で予告し、押した後にこの確認を出す (取り消したら実行しない)。
 * 所有者名は本文へ埋めず clamp した独立した行 (subject) へ 1 回だけ出し、起動コマンドも等幅の別行にする
 * (所有者名は会話名なので「停止」だけでは会話やエージェントを止める意味に読める。タイトルは初回メッセージ
 * 由来で最大 60 文字になるため、文章へ埋めると読めなくなる)。ボタンは何をするかを書く。
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

/** 起動の失敗を表示する 1 行。押した後の遷移状態から戻したときに出す */
export function servedAppErrorText(error: string | undefined): string | undefined {
  const text = error?.trim();
  return text ? `サービスの操作に失敗しました: ${text}` : undefined;
}
