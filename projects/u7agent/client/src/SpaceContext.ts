import { createContext, useContext } from "react";
import type { Space } from "server";
import type { createSpaceApi } from "./api";

export type SpaceContextValue = {
  spaces: Space[];
  selected: Space;
  select: (id: string) => void;
  create: (name: string) => Promise<void>;
  /**
   * 追加スペースを箱ごと消す。成功したら一覧から外し、選択中のスペースを消したときは既定スペースへ
   * 切り替える。`onSelectionReset` は選択の更新より先に呼ぶ (会話を持たない chat への導線が URL を
   * 確定させ、`App` の作り直しはその時点の URL を読むため)。
   */
  remove: (id: string, onSelectionReset?: () => void) => Promise<void>;
  api: ReturnType<typeof createSpaceApi>;
};

export const SpaceContext = createContext<SpaceContextValue | null>(null);

export function useSpace() {
  const context = useContext(SpaceContext);
  if (!context) throw new Error("会話スペースが選択されていません");
  return context;
}

export function useSpaceApi() {
  return useSpace().api;
}
