import { useState } from "react";

let lastImageVersion = 0;

export function useImageVersion(reloadToken: number): number {
  const [state, setState] = useState(() => ({ reloadToken, version: ++lastImageVersion }));
  if (state.reloadToken !== reloadToken) {
    const next = { reloadToken, version: ++lastImageVersion };
    setState(next);
    return next.version;
  }
  return state.version;
}
