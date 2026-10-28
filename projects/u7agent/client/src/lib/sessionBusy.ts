/**
 * 会話が実行中かどうかの判定を 1 か所に置く。BFF の `SessionStore.isBusy`（`server/src/sessions.ts`）と
 * 同じ集合（実行 / キュー待ち / 圧縮中）で、終端（`completed` / `stopped` / `error`）と `idle` は false。
 * 同じ 3 値判定を画面ごとに書き分けると、集合が変わったときに片側だけ追随しない経路が残る。
 */
import type { RunStatus, SessionSummary } from "../types";

export function sessionBusy(runStatus: string): boolean {
  return runStatus === "running" || runStatus === "queued" || runStatus === "compacting";
}

/** 同じ作業フォルダを共有し得る会話の最小情報。プロジェクト会話は全セッションが同じ cwd を共有する */
type WorkdirSession = Pick<SessionSummary, "sessionId" | "projectId" | "status">;

/**
 * 公開元と同じ作業フォルダを共有する他会話が実行中か。`projectId` が無い（未所属）会話は
 * 会話ごとの scratch（`.u7agent/sessions/<id>`）を持つので、同じ cwd の兄弟は存在しない。
 */
export function siblingRunBusy(input: {
  sessionId: string;
  projectId?: string;
  sessions: readonly WorkdirSession[];
}): boolean {
  const { sessionId, projectId, sessions } = input;
  return (
    projectId !== undefined &&
    sessions.some(
      (entry) => entry.sessionId !== sessionId && entry.projectId === projectId && sessionBusy(entry.status),
    )
  );
}

/** 同じ作業フォルダの会話のうち誰が実行中か。文言の出し分けに使う */
export type WorkdirBusyKind = "self" | "other";

/**
 * 同じ作業フォルダの会話が実行中か。誰が実行中かで文言を変えるため `self` / `other` を返す
 * （`serve` の `servedAppBusyKind` は集合が違うので別に持つ。あちらは圧縮中の会話を実行者として数えない）。
 */
export function workdirBusyKind(input: {
  selfStatus: RunStatus;
  sessionId: string;
  projectId?: string;
  sessions: readonly WorkdirSession[];
}): WorkdirBusyKind | undefined {
  if (sessionBusy(input.selfStatus)) return "self";
  return siblingRunBusy(input) ? "other" : undefined;
}
