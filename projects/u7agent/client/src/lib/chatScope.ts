/**
 * main 領域に出す「作業先」を決める純関数。セッションが無ければ作成先 (selectedProjectId)、
 * あればセッションの所属を採り、左バーの groupSessionsByProject と同じ規則で未所属へ寄せる。
 * 一覧の取得前や消えた id では未所属に倒す (一時的な食い違いは許容する。docs/ui-layout.md)。
 */
import type { Project, SessionSummary } from "../types";

export type ChatScopeInput = {
  /** 表示中セッションの作業フォルダ (payload.cwd)。未作成チャットでは "" */
  cwd: string;
  /** 選択中セッション。"" は未作成チャット (作成先がそのまま作業先) */
  sessionId: string;
  /** 未作成チャットの作成先。セッションがあるときは見ない */
  selectedProjectId: string;
  projects: Project[];
  /** 所属の解決に使う。一覧に無い id は未所属 */
  sessions: SessionSummary[];
};

export type ChatScope = {
  /** 作業先の表示名。プロジェクト名が引けなければ「未所属」 */
  label: string;
  /** プロジェクト配下か。空状態の見出しの分岐に使う */
  project: boolean;
  /** 作業先の作業フォルダ (root 相対)。未解決は "" */
  root: string;
};

export function chatScope({ cwd, sessionId, selectedProjectId, projects, sessions }: ChatScopeInput): ChatScope {
  const projectId =
    sessionId === "" ? selectedProjectId : (sessions.find((item) => item.sessionId === sessionId)?.projectId ?? "");
  const project = projects.find((item) => item.id === projectId);
  return {
    label: project?.name ?? "未所属",
    project: project !== undefined,
    // 解除されたプロジェクトのセッションでも、フォルダは残るので payload.cwd を優先する
    root: cwd || project?.cwd || "",
  };
}
