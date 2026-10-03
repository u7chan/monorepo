import { useEffect, useState } from "react";
import { getGitInfo } from "../api";
import { normalizeFileTreeRoot } from "../lib/fileTree";
import { createRequestGate } from "./requestGate";

/**
 * 作業フォルダ (root 相対) が属する repo のブランチ。`reloadToken` が変わるたびに取り直す
 * (一覧と開いている本文と同じ合図で更新する)。取得中は直前の値を残してチップを消さず、
 * repo の外・取得失敗は null にして古い値を「いまのブランチ」として見せない。
 * 連打で古い応答が後から届いても、最後の要求だけを反映する (StrictMode の effect 再実行でも同じ)。
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
