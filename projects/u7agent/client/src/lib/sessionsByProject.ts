/**
 * セッション一覧をプロジェクト別に分ける純関数。DOM に依存しない。
 * プロジェクトは一覧の並び (サーバーの作成順) を保ち、配下セッションは lastUsedAt の降順にする。
 */
import type { Project, SessionSummary } from "../types";

export type ProjectSessionGroup = {
  project: Project;
  sessions: SessionSummary[];
};

/** 同時刻は元の並び (サーバーの順) を保つ */
function byLastUsedDesc(a: SessionSummary, b: SessionSummary): number {
  return b.lastUsedAt - a.lastUsedAt;
}

export function groupSessionsByProject(
  sessions: SessionSummary[],
  projects: Project[],
): { groups: ProjectSessionGroup[]; unassigned: SessionSummary[] } {
  const known = new Set(projects.map((project) => project.id));
  const groups = projects.map((project) => ({
    project,
    sessions: sessions.filter((session) => session.projectId === project.id).sort(byLastUsedDesc),
  }));
  // 未知の projectId は未所属へ寄せる。破棄直後やプロジェクト取得前の一覧でも
  // セッションをどこにも出さずに失うより、Chats に出して選択できるようにする。
  const unassigned = sessions
    .filter((session) => !session.projectId || !known.has(session.projectId))
    .sort(byLastUsedDesc);
  return { groups, unassigned };
}
