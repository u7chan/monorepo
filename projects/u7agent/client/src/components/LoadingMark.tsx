import { RunSpinnerIcon } from "./icons";

/**
 * 取得待ちの印。見た目はスピナーだけにし、文字は sr-only で残す。スピナーは aria-hidden のため、
 * 両方を消すと読み上げが空になる (状態を持つのは文字の側)。図形・色・動きを止める設定での扱いは
 * RunSpinnerIcon と styles/index.css が正。
 */
export function LoadingMark() {
  return (
    // sr-only の文字は絶対配置で、位置指定の無い祖先を基準にする。スクロール枠 (閉じた枝の中など) が
    // 位置指定を持たないと、枠が切っている印の箱が外側の scrollable overflow として数えられ、
    // 外装のスクロール範囲が印の位置まで伸びる。印自身を基準にして、印の箱の中で閉じる
    <span role="status" className="relative inline-flex items-center gap-2">
      <RunSpinnerIcon />
      <span className="sr-only">読み込み中…</span>
    </span>
  );
}
