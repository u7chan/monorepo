/**
 * singleColumn の作業環境シートが「どの面を見せているか」。root は dialog の key でもあるため、退場アニメの間に
 * 動くと dialog が作り直されてアニメが途中で切れ、中身も入れ替わる。決めるのは値だけにして DOM は触らない。
 */

import type { FilesMode } from "./fileRefRequest";

export type SheetView = {
  root: string;
  mode: FilesMode;
};

export function sameSheetView(a: SheetView, b: SheetView): boolean {
  return a.root === b.root && sameMode(a.mode, b.mode);
}

/**
 * シートに次に見せる面。null は「今のままにする」。開いていない間 (閉じる導線がモードを既定へ戻す) と
 * scope の変更で閉じる描画 (state が古い `true` のまま) は、取り込むと中身が入れ替わるので追従しない。
 */
export function nextSheetView(
  current: SheetView,
  live: SheetView,
  open: boolean,
  scopeChanged: boolean,
): SheetView | null {
  if (!open || scopeChanged) return null;
  return sameSheetView(current, live) ? null : live;
}

function sameMode(a: FilesMode, b: FilesMode): boolean {
  if (a.kind === "work" || b.kind === "work") return a.kind === b.kind;
  return a.root === b.root;
}
