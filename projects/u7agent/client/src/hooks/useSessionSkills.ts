import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { getSessionSkills, getSessionSkillsPreview } from "../api";
import {
  fetchSessionSkills,
  sessionSkillsSource,
  sessionSkillsSourceKey,
  type SessionSkillsState,
} from "../lib/sessionSkills";
import { createRequestGate } from "./requestGate";

export type { SessionSkillsState } from "../lib/sessionSkills";

/**
 * チャットのスキル一覧。セッションが確定していれば既存 API、新規チャットなら作成前の選択で解決する
 * プレビュー API を使う。取得キー (sessionId、無ければ projectId と agentId) が変わるたびに取り直す
 * (本文は送信時に BFF が読むため、一覧は優先順位の表示に使う)。
 */
export function useSessionSkills({
  sessionId,
  projectId,
  agentId,
  enabled,
}: {
  sessionId: string;
  /** プレビューで使う所属。未所属は "" */
  projectId: string;
  /** プレビューで使うエージェント。未選択は "" (サーバーがビルトインへ解決する) */
  agentId: string;
  /** 取得先が判明しているか。起動直後は保存された選択がまだ検証されていないため取得しない */
  enabled: boolean;
}): {
  state: SessionSkillsState;
  reload: () => void;
} {
  const [state, setState] = useState<SessionSkillsState>({ status: "unavailable" });
  const [beginRequest] = useState(createRequestGate);
  const [reloadCount, setReloadCount] = useState(0);

  // 常に最新の取得先を使うが、依存は取得キーだけにする (Effect Event は依存に含めない)。セッションがある間の
  // projectId / agentId の切替では取得先が変わらないため、一覧を取り直さない (再走査と読込表示を避ける)
  const load = useEffectEvent((canApply: () => boolean) => {
    void fetchSessionSkills(
      sessionSkillsSource(sessionId, projectId, agentId),
      { session: getSessionSkills, preview: getSessionSkillsPreview },
      canApply,
      (next) => setState(next),
    );
  });
  const sourceKey = sessionSkillsSourceKey(sessionSkillsSource(sessionId, projectId, agentId));

  useEffect(() => {
    // 新規チャットへ移ったときも取得を無効化する。早期 return で抜けると、旧セッションの
    // 応答が後から届いて一覧を書き換える (存在しないセッションのスキルを見せる)
    const canApply = beginRequest();
    if (!enabled) {
      setState({ status: "unavailable" });
      return;
    }
    setState({ status: "loading" });
    load(canApply);
  }, [beginRequest, enabled, reloadCount, sourceKey]);

  const reload = useCallback(() => setReloadCount((count) => count + 1), []);

  return { state, reload };
}
