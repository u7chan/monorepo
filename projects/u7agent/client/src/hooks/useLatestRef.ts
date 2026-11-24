import { useRef, type RefObject } from "react";

/**
 * 最新の値を持つ ref。描画のたびに作り直される値（一覧・callback）を、`useState` の初期化で
 * 1 度だけ組む flow の依存に読ませる。`useEffect` で写すと、effect の実行前に走る同じ描画中の
 * 操作（一覧の行を押したときの確定など）が古い値を見る。
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
