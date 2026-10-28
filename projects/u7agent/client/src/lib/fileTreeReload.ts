/**
 * ファイルツリーの再読み込みと、進行中の一覧取得の競合。取得中にその場で invalidate すると、
 * 後から届く古い応答が loading を解除してしまい、取り直しが失われる。取得中の要求は保留し、
 * 最後の取得が決着したところで 1 回だけ反映する。
 */

export type FileTreeReloadGate = { pending: boolean };

export function requestFileTreeReload(
  gate: FileTreeReloadGate,
  inFlight: number,
): { gate: FileTreeReloadGate; applyNow: boolean } {
  if (inFlight > 0) return { gate: { ...gate, pending: true }, applyNow: false };
  // 取得が無ければ保留は不要 (前の待ちが残っていても、今すぐ反映してよい)
  return { gate: { ...gate, pending: false }, applyNow: true };
}

export function settleFileTreeRequest(
  gate: FileTreeReloadGate,
  inFlight: number,
): { gate: FileTreeReloadGate; applyNow: boolean } {
  if (!gate.pending || inFlight > 0) return { gate, applyNow: false };
  return { gate: { pending: false }, applyNow: true };
}
