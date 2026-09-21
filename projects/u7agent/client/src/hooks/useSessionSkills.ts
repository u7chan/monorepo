import { useCallback, useEffect, useState } from "react";
import { getSessionSkills } from "../api";
import type { SessionSkillInfo } from "../types";
import { createRequestGate } from "./requestGate";

/**
 * セッションのスキル一覧。セッション未確定 (新規チャット) では取得せず unavailable のままにする。
 * セッションが変わるたびに取り直す (本文は送信時に BFF が読むため、一覧は優先順位の表示に使う)。
 */
export type SessionSkillsState =
  | { status: "unavailable" }
  | { status: "loading" }
  | { status: "ready"; skills: SessionSkillInfo[]; projectSkills: boolean }
  | { status: "error"; message: string };

export function useSessionSkills(
  sessionId: string,
  enabled: boolean,
): {
  state: SessionSkillsState;
  reload: () => void;
} {
  const [state, setState] = useState<SessionSkillsState>({ status: "unavailable" });
  const [beginRequest] = useState(createRequestGate);
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    // 新規チャットへ移ったときも取得を無効化する。早期 return で抜けると、旧セッションの
    // 応答が後から届いて一覧を書き換える (存在しないセッションのスキルを見せる)
    const canApply = beginRequest();
    if (!enabled || !sessionId) {
      setState({ status: "unavailable" });
      return;
    }
    setState({ status: "loading" });
    void (async () => {
      try {
        const response = await getSessionSkills(sessionId);
        if (canApply()) {
          setState({ status: "ready", skills: response.skills, projectSkills: response.projectSkills });
        }
      } catch (error) {
        if (canApply()) {
          setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
        }
      }
    })();
  }, [beginRequest, enabled, reloadCount, sessionId]);

  const reload = useCallback(() => setReloadCount((count) => count + 1), []);

  return { state, reload };
}
