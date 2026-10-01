/**
 * 左バーのセッション行の状態表示。入力は BFF の `SessionSummary.status` だけで、表示の語彙と
 * live / idle の別をここで決める (dot のクラスは組まない)。左バーは「いま動いている」状態だけを
 * 出す方針で、待機件数と終端は行に出さない (正は docs/ui-layout.md)。
 */
import type { SessionSummary } from "../types";

export type SidebarStatus = {
  /** 空は無表示 (終端 / idle) */
  label: "実行中" | "圧縮中" | "";
  tone: "live" | "idle";
};

/**
 * `queued` を `実行中` へ畳むのは、待機メッセージがあるのにランが無い短い過渡 (次のランが
 * 始まるまで、または手動圧縮の終端) だから。待機していることは開いている会話の Composer が示す。
 */
export function sidebarStatus(status: SessionSummary["status"]): SidebarStatus {
  switch (status) {
    case "running":
    case "queued":
      return { label: "実行中", tone: "live" };
    case "compacting":
      return { label: "圧縮中", tone: "live" };
    default:
      return { label: "", tone: "idle" };
  }
}
