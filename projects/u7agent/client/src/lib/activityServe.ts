/**
 * 実行状況の「公開中のサービス」1 行と、行ごとの操作の決定。公開枠は全会話で共有の 1 本なので、
 * 稼働状態は全スペース共通の runtime status を正とし、取得できない間はリンクも起動も停止も出さない
 * (既存の 設定 → ランタイム と同じ規則)。描画は components/ActivityServiceRow と components/ActivityRowItem。
 */
import type { RuntimeServeStatus } from "../types";
import type { ActivityRow } from "./activity";
import type { ConfirmRequest } from "./confirmDialog";
import { servedAppUrl } from "./servedApp";

/** サービス行の状態。`loading` はまだ一度も取得できていない (停止中と区別する) */
export type ActivityServiceKind = "loading" | "failed" | "stopped" | "starting" | "running" | "unknown";

export type ActivityServiceView = {
  kind: ActivityServiceKind;
  /** 状態のラベル */
  label: string;
  /** 稼働中の起動元の会話。起動元が特定できないときは載せない (推測しない) */
  owner?: { sessionId: string; title: string; spaceId?: string };
  /** 起動中の対象 (行から拾った表示用の値)。会話が一覧から消えたときは title を載せない */
  launching?: { title?: string; command?: string };
  /** 稼働記録と待受が一致しているときの起動コマンドと作業ディレクトリ */
  command?: { cwd: string; command: string };
  /** `開く` の URL。公開ポートが未取得なら undefined (リンクを出さない) */
  url?: string;
  canStop: boolean;
};

/**
 * サービス状態の見え方。起動中は取得の値より優先する (起動の確定は最大 10 秒後なので、
 * その間のプローブ結果を「停止中」として出さない)。
 */
export function activityServiceView({
  status,
  failed,
  launching,
  hostname,
  port,
}: {
  status: RuntimeServeStatus | null;
  failed: boolean;
  launching?: { title?: string; command?: string };
  hostname: string;
  port?: number;
}): ActivityServiceView {
  if (failed) return { kind: "failed", label: "状態を取得できません", canStop: false };
  if (!status) return { kind: "loading", label: "状態を取得しています…", canStop: false };
  if (launching) return { kind: "starting", label: "起動中…", launching, canStop: false };
  if (!status.reachable) return { kind: "stopped", label: "停止中", canStop: false };
  const url = servedAppUrl(hostname, port);
  return {
    kind: status.owner ? "running" : "unknown",
    label: status.owner ? "稼働中" : "稼働中（起動元不明）",
    ...(status.owner ? { owner: status.owner } : {}),
    ...(status.command ? { command: status.command } : {}),
    ...(url === undefined ? {} : { url }),
    canStop: status.generation !== null,
  };
}

/** 行の操作。`starting` はその行の起動の確認待ち (行を操作に変えない) */
export type ActivityRowAction = "none" | "open" | "start" | "starting";

export type ActivityRowServe = {
  /** この会話のサービスが公開中 (行に「稼働中」を付ける) */
  served: boolean;
  action: ActivityRowAction;
  /** 操作はあるが押せない (別の行の起動中) */
  disabled: boolean;
  /** `start` の起動コマンド */
  command?: string;
  /** `open` の URL */
  url?: string;
};

const NO_ROW_ACTION: ActivityRowServe = { served: false, action: "none", disabled: false };

/**
 * 行の操作を決める。稼働中の起動元は `開く`、終了行でその作業ディレクトリに serve の実績があるものだけ
 * `起動` を出し、実行中の行には出さない (エージェントの serve と競合させない)。状態を取得できない間は
 * どの行にも操作を出さない。
 */
export function activityRowServe({
  row,
  status,
  failed,
  starting,
  hostname,
  port,
}: {
  row: Pick<ActivityRow, "sessionId" | "kind" | "serveCommand">;
  status: RuntimeServeStatus | null;
  failed: boolean;
  /** 起動の確認待ちの対象 (会話 id)。同時に 1 件だけ */
  starting: string | null;
  hostname: string;
  port?: number;
}): ActivityRowServe {
  if (failed || !status) return NO_ROW_ACTION;
  const served = status.reachable && status.owner?.sessionId === row.sessionId;
  if (starting === row.sessionId) return { served, action: "starting", disabled: true };
  const disabled = starting !== null;
  if (served) {
    const url = servedAppUrl(hostname, port);
    return url === undefined
      ? { served: true, action: "none", disabled }
      : { served: true, action: "open", disabled, url };
  }
  if (row.kind === "finished" && row.serveCommand) {
    return { served: false, action: "start", disabled, command: row.serveCommand };
  }
  return { served: false, action: "none", disabled: false };
}

/**
 * 起動の確認。公開中のサービスがあれば置き換えなので、いま公開中の起動元と、その作業ディレクトリ・
 * 起動コマンドを出す (どのディレクトリを止めて、どの会話を起動するのかを押す前に読めるようにする)。
 * 対象の会話名は本文へ埋めず subject へ 1 回だけ出す。
 */
export function runtimeServeStartConfirm(
  row: Pick<ActivityRow, "title" | "serveCommand">,
  status: RuntimeServeStatus,
): ConfirmRequest {
  const replace = status.reachable;
  const current = status.command;
  const notes = replace
    ? [
        current
          ? `いま公開中の作業ディレクトリ: ${current.cwd || "."}（${current.command}）`
          : "いま公開中のサービスは起動元を特定できません。",
      ]
    : undefined;
  return {
    kind: "confirm",
    title: "サービスを起動",
    body: replace
      ? [
          status.owner
            ? `公開中の「${status.owner.title}」を停止して置き換えます。`
            : "起動元不明のプロセスを停止して置き換えます。",
        ]
      : [],
    subject: { label: "起動元の会話", value: row.title },
    ...(row.serveCommand ? { code: { label: "起動コマンド", value: row.serveCommand } } : {}),
    ...(notes ? { notes } : {}),
    confirmLabel: replace ? "停止して起動" : "起動する",
    danger: replace,
  };
}
