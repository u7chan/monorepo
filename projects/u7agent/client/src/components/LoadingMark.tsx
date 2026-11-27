import { RunSpinnerIcon } from "./icons";

/**
 * 取得待ちの印。見た目はスピナーだけで文字は sr-only に残す (スピナーは aria-hidden なので両方消すと
 * 読み上げが空になる)。図形・色・動きの設定は RunSpinnerIcon と styles/index.css が正。
 */
export function LoadingMark() {
  return (
    /**
     * sr-only の文字は絶対配置で、位置指定の無い祖先を基準にする。スクロール枠が位置指定を持たないと
     * 枠の外へ overflow が数えられ外装が伸びるため、印自身を基準にして箱の中で閉じる。
     */
    <span role="status" className="relative inline-flex items-center gap-2">
      <RunSpinnerIcon />
      <span className="sr-only">読み込み中…</span>
    </span>
  );
}
