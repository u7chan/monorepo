import { useCallback, useEffect, useState } from "react";
import { getFileSkills } from "../api";
import type { FileSkillInfo } from "../types";
import { createRequestGate } from "./requestGate";

/** 読み取り専用の一覧なので、状態は「読み込み中 / 取得済み / 失敗」の 3 つだけ持つ */
export type FileSkillsState =
  | { status: "loading" }
  | { status: "ready"; skills: FileSkillInfo[] }
  | { status: "error"; message: string };

/**
 * 共通スキル (`.agents/skills`) の一覧。取得のたびに `beginFileSkillsRequest` で古い応答を無効化し、
 * 再読み込みを連打しても最後の要求だけを反映する (StrictMode の effect 再実行でも同じ結果になる)。
 */
export function useFileSkills(): { state: FileSkillsState; reload: () => void } {
  const [state, setState] = useState<FileSkillsState>({ status: "loading" });
  const [beginFileSkillsRequest] = useState(createRequestGate);

  const load = useCallback(async () => {
    const canApply = beginFileSkillsRequest();
    setState({ status: "loading" });
    try {
      const { skills } = await getFileSkills();
      if (canApply()) setState({ status: "ready", skills });
    } catch (error) {
      if (canApply()) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [beginFileSkillsRequest]);

  useEffect(() => {
    void load();
  }, [load]);

  const reload = useCallback(() => {
    void load();
  }, [load]);

  return { state, reload };
}
