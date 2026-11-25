import { useCallback, useState } from "react";
import { handoffSuggestion } from "../lib/sessionHandoff";
import { suggestionScopeChange, type SuggestionScope } from "../lib/suggestion";
import type { AgentSuggestion, PromptRef, SessionHandoffState } from "../types";

/**
 * 入力欄のチップ (選択中の定型プロンプトと、引き継ぎ直後の HANDOFF.md の案内) と、
 * 選択を捨てる契機の監視キー。持ち越すと、別の会話・別のエージェントの提案が入力欄に残る (添付と同じ契約)。
 */
export type SuggestionChipSource = {
  /** 未作成チャットの選択中エージェント。切り替えると選択を捨てる */
  agentId: string | undefined;
  /** newChat / 別の会話を開くで進む世代。添付の暗黙の会話作成では進まない */
  selectionSeq: number;
  /** 会話 id。未作成チャットは "" で、添付が会話を作った時点で新しい id になる */
  sessionId: string;
  /** 会話の引き継ぎ状態。HANDOFF.md のチップはここから導出する (外したことだけを覚える) */
  handoff: SessionHandoffState | undefined;
};

export type SuggestionChip = {
  /** 入力欄へ出すチップ。定型プロンプトの選択が引き継ぎの案内より優先 */
  active: AgentSuggestion | null;
  /** チップを選ぶ。押すたびに新しい値を渡す (同じチップを押し直しても入力欄へフォーカスを戻す合図にする) */
  select: (next: PromptRef) => void;
  /** チップを外す。定型プロンプトは選択を捨て、引き継ぎの案内は外した印だけを覚える */
  clear: () => void;
};

/**
 * チップの選択と、選択を捨てる契機。スペースの切替は App ごと作り直すため見ない。
 * 会話 id だけの変化 (添付が暗黙に作った会話) では捨てないので、判定は lib/suggestion.ts の純関数が持つ。
 */
export function useSuggestionChip({ agentId, selectionSeq, sessionId, handoff }: SuggestionChipSource): SuggestionChip {
  // チップは選択した時点の文言を写して持つ (マスタを編集しても、選択済みのチップは書き換えない)
  const [suggestion, setSuggestion] = useState<AgentSuggestion | null>(null);
  const [scope, setScope] = useState<SuggestionScope>(() => ({ agentId, selectionSeq, sessionId }));
  const nextScope: SuggestionScope = { agentId, selectionSeq, sessionId };
  if (suggestionScopeChange(scope, nextScope) === "drop") {
    setScope(nextScope);
    setSuggestion(null);
  } else if (scope.sessionId !== nextScope.sessionId) {
    // 添付が会話を暗黙に作っただけ。チップは同じ下書きの続きとして、その会話へ移す
    setScope(nextScope);
  }
  // 引き継ぎのチップを外した印 (操作 ID)。表示は会話の状態から導出し、外したことだけを覚える
  // (リロードでは戻り、新しい引き継ぎでは ID が変わるため再び出る)
  const [dismissedHandoff, setDismissedHandoff] = useState<string | null>(null);
  const handoffChip = handoffSuggestion(handoff);
  const handoffOperationId = handoff?.operationId ?? "";
  const active = suggestion ?? (handoffChip && dismissedHandoff !== handoffOperationId ? handoffChip : null);
  const select = useCallback((next: PromptRef) => setSuggestion({ label: next.label, prompt: next.prompt }), []);
  const clear = useCallback(() => {
    if (suggestion) {
      setSuggestion(null);
      return;
    }
    if (handoffChip) setDismissedHandoff(handoffOperationId);
  }, [handoffChip, handoffOperationId, suggestion]);
  return { active, select, clear };
}
