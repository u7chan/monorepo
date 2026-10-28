import type { ReactNode } from "react";

/**
 * FileBrowser を置く面のスクロール所有者。1 行のグリッドでブラウザへ面の高さを渡し、
 * はみ出したプレビューの本文だけをスクロールさせる (ツリーの内側スクロールと面の高さは動かさない)。
 */
export function FileBrowserScrollArea({ children }: { children: ReactNode }) {
  return <div className="grid min-h-0 scrollbar-thin grid-rows-1 overflow-x-hidden overflow-y-auto">{children}</div>;
}
