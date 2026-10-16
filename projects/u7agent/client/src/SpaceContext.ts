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
  /**
   * 並べ替えを保存する。応答はサーバーが採用した順の id で、既定スペースも含む
   * （`sortOrder` は応答に出ない。docs/api.md#スペース）。
   */
  reorder: (ids: readonly string[]) => Promise<readonly string[]>;
  /**
   * 保存が返した順を現在の一覧へマージする。**渡されなかった行（既定スペース・保存待ちの間に作られた行）は
   * 元の位置に残す**（応答で一覧全体を置き換えず、作成・削除の差分更新を巻き戻さないため）。
   */
  applyOrder: (ids: readonly string[]) => void;
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
