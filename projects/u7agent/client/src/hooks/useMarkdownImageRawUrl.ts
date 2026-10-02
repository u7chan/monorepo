import { useCallback } from "react";
import { fileRawUrl } from "../api";
import { useImageVersion } from "./useImageVersion";

export function useMarkdownImageRawUrl(runEndSeq: number): (path: string) => string {
  const version = useImageVersion(runEndSeq);
  return useCallback((path: string) => fileRawUrl(path, version), [version]);
}
