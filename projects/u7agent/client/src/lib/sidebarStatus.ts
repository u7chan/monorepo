/**
 * 左バーのセッション行の状態表示。入力は `SessionSummary` の status と awaitingAnswer だけで、語彙と
 * live / waiting / idle の別をここで決める (左バーは「いま動いている」状態だけを出す)。
 */
import type { SessionSummary } from "../types";

export type SidebarStatus = {
  /** 空は無表示 (終端 / idle) */
  label: "実行中" | "圧縮中" | "回答待ち" | "";
  tone: "live" | "waiting" | "idle";
};

/**
 * `queued` を `実行中` へ畳むのは、待機はあるがランが無い短い過渡だから (待機はコンポーザー直上の
 * ブロックが示す)。回答待ちは `running` / `queued` の代わりに出す (同時には起きないが圧縮を先に見る)。
 */
export function sidebarStatus(status: SessionSummary["status"], awaitingAnswer: boolean): SidebarStatus {
  if (status === "compacting") return { label: "圧縮中", tone: "live" };
  if (awaitingAnswer) return { label: "回答待ち", tone: "waiting" };
  switch (status) {
    case "running":
    case "queued":
      return { label: "実行中", tone: "live" };
    default:
      return { label: "", tone: "idle" };
  }
}
