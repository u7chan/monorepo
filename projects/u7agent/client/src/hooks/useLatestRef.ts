import { useRef, type RefObject } from "react";

/**
 * 最新の値を持つ ref。描画のたびに作り直される値を `useState` の初期化で 1 度だけ組む flow の依存に
 * 読ませる (`useEffect` で写すと、同じ描画中の操作が古い値を見る)。
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
