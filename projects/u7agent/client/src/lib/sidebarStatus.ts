/**
 * 左バーのセッション行の状態表示。入力は BFF の `SessionSummary` の status と awaitingAnswer だけで、
 * 表示の語彙と live / waiting / idle の別をここで決める (dot のクラスは組まない)。左バーは「いま動いて
 * いる」状態だけを出す方針で、待機件数と終端は行に出さない (正は docs/ui-layout.md)。
 */
import type { SessionSummary } from "../types";

export type SidebarStatus = {
  /** 空は無表示 (終端 / idle) */
  label: "実行中" | "圧縮中" | "回答待ち" | "";
  tone: "live" | "waiting" | "idle";
};

/**
 * `queued` を `実行中` へ畳むのは、待機メッセージがあるのにランが無い短い過渡 (次のランが
 * 始まるまで、または手動圧縮の終端) だから。待機は開いている会話のコンポーザー直上のブロック
 * (`client/src/lib/queueWait.ts` が導出する件数と順位) が示す。
 *
 * 回答待ちは `running` / `queued` の代わりに出す (回答しないと進まないことを示す)。同時には
 * 起きないが、圧縮の排他だけは先に見る。
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
