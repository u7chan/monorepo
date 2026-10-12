/**
 * compact の作業環境シートが「どの面を見せているか」。root は dialog の key でもあるため、退場アニメの間に
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
 * シートに次に見せる面。null は「今のままにする」。
 * 追従させない描画が 2 つある。
 *
 * - 開いていない間: 閉じる導線はモードを既定 (作業フォルダ) へ戻すため、取り込むとスライド中に中身が
 *   入れ替わる。開き直すときは開いた描画で追いつく
 * - scope (root / 画面 / layout) の変更で閉じる描画: 開閉の state が古い `true` のままなので、開いていると
 *   誤認して新しい root を取り込む。key が動いて、退場させたい dialog が作り直されてしまう
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
