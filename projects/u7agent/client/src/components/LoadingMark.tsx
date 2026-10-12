import { RunSpinnerIcon } from "./icons";

/**
 * 取得待ちの印。見た目はスピナーだけにし、文字は sr-only で残す。スピナーは aria-hidden のため、
 * 両方を消すと読み上げが空になる (状態を持つのは文字の側)。図形・色・動きを止める設定での扱いは
 * RunSpinnerIcon と styles/index.css が正。
 */
export function LoadingMark() {
  return (
    <span role="status" className="inline-flex items-center gap-2">
      <RunSpinnerIcon />
      <span className="sr-only">読み込み中…</span>
    </span>
  );
}
