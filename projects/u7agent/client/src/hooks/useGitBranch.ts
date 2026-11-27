import { useEffect, useState } from "react";
import { getGitInfo } from "../api/files";
import { normalizeFileTreeRoot } from "../lib/fileTree";
import { createRequestGate } from "./requestGate";

/**
 * 作業フォルダが属する repo のブランチ。`reloadToken` が変わるたびに取り直し、取得中は直前の値を残す。
 * repo の外・取得失敗は null にし (古い値を「いまのブランチ」として見せない)、最後の要求だけを反映する。
 */
export function useGitBranch(root: string, reloadToken: number): string | null {
  const [branch, setBranch] = useState<string | null>(null);
  const [beginRequest] = useState(createRequestGate);

  useEffect(() => {
    const path = normalizeFileTreeRoot(root);
    const canApply = beginRequest();
    void (async () => {
      try {
        const info = await getGitInfo(path);
        if (canApply()) setBranch(info.branch);
      } catch {
        if (canApply()) setBranch(null);
      }
    })();
  }, [root, reloadToken, beginRequest]);

  return branch;
}
