import { createContext, useContext } from "react";
import type { Space } from "server";
import type { createSpaceApi } from "./api";

export type SpaceContextValue = {
  spaces: Space[];
  selected: Space;
  select: (id: string) => void;
  create: (name: string) => Promise<void>;
  api: ReturnType<typeof createSpaceApi>;
};

export const SpaceContext = createContext<SpaceContextValue | null>(null);

export function useSpace() {
  const context = useContext(SpaceContext);
  if (!context) throw new Error("スペースが選択されていません");
  return context;
}

export function useSpaceApi() {
  return useSpace().api;
}
