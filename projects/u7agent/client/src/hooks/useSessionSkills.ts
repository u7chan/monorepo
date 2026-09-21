import { useCallback, useEffect, useState } from "react";
import { getSessionSkills } from "../api";
import type { SessionSkillInfo } from "../types";
import { createRequestGate } from "./requestGate";

/**
 * セッションのスキル一覧。セッション未確定 (新規チャット) では取得せず unavailable のままにする。
 * 一覧を開いたときにだけ取得し、セッションが変わったら取り直す (本文は送信時に BFF が読む)。
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
    if (!enabled || !sessionId) {
      setState({ status: "unavailable" });
      return;
    }
    const canApply = beginRequest();
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
