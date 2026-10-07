import type { Space } from "server";

export const SPACE_SELECTION_KEY = "u7agent-space";

export function selectedSpace(spaces: Space[], stored: string | null): Space | undefined {
  const id = stored === null ? "default" : stored;
  return spaces.find((space) => space.id === id);
}

export function readSpaceSelection(storage: Pick<Storage, "getItem">): string | null {
  return storage.getItem(SPACE_SELECTION_KEY);
}

export function writeSpaceSelection(storage: Pick<Storage, "setItem">, id: string): void {
  storage.setItem(SPACE_SELECTION_KEY, id);
}
