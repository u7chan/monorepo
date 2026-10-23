/**
 * 一覧の state は全スペースで 1 本 (実行状況ダッシュボードのため) なので、現在のスペースの一覧は
 * ここで抜く。サイドバー・モデルの最終使用・選択の移り先は、従来どおり現在スペースだけを見る。
 */
import type { SessionSummary } from "../types";
import { DEFAULT_SPACE_ID } from "./spaceSelection";

export function sessionsInSpace(sessions: readonly SessionSummary[], spaceId: string): SessionSummary[] {
  return sessions.filter((item) => (item.spaceId ?? DEFAULT_SPACE_ID) === spaceId);
}
