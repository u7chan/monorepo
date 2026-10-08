/**
 * セッション一覧をプロジェクト別に分ける純関数。DOM に依存しない。
 * プロジェクト順は一覧に従い、各会話グループではピン留めを先にしてから lastUsedAt の降順にする。
 */
import type { Project, SessionSummary } from "../types";

export type ProjectSessionGroup = {
  project: Project;
  sessions: SessionSummary[];
};

/** 同時刻は元の並び (サーバーの順) を保つ */
function byPinnedThenLastUsedDesc(a: SessionSummary, b: SessionSummary): number {
  const pinOrder = Number(b.pinned === true) - Number(a.pinned === true);
  return pinOrder || b.lastUsedAt - a.lastUsedAt;
}

export function groupSessionsByProject(
  sessions: SessionSummary[],
  projects: Project[],
): { groups: ProjectSessionGroup[]; unassigned: SessionSummary[] } {
  const known = new Set(projects.map((project) => project.id));
  const groups = projects.map((project) => ({
    project,
    sessions: sessions.filter((session) => session.projectId === project.id).sort(byPinnedThenLastUsedDesc),
  }));
  // 未知の projectId は未所属へ寄せる。破棄直後やプロジェクト取得前の一覧でも
  // セッションをどこにも出さずに失うより、Chats に出して選択できるようにする。
  const unassigned = sessions
    .filter((session) => !session.projectId || !known.has(session.projectId))
    .sort(byPinnedThenLastUsedDesc);
  return { groups, unassigned };
}
