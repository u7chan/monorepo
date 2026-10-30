import { useCallback, useEffect, useState } from "react";
import { createPrompt, deletePrompt, getPrompts, updatePrompt } from "../api";
import { reorderRows } from "../lib/agentReorder";
import { promptRefreshFailure } from "../lib/promptSettings";
import type { PromptDef } from "../types";
import { createLoadingTracker, createRequestGate } from "./requestGate";

/**
 * 一覧の取得状態。読み込み中 / 取得済み / 失敗を区別し、空の一覧と混同しない。
 * 失敗しても直前の一覧は保持する (再取得の失敗で、表示中のマスタを消さない)。
 */
export type PromptsState =
  | { status: "loading"; prompts: PromptDef[] }
  | { status: "ready"; prompts: PromptDef[] }
  | { status: "error"; prompts: PromptDef[]; message: string };

/**
 * 変更の結果。**保存 / 削除そのものの成否**と、その後の一覧 / エージェントカタログの
 * 再取得の失敗を分ける (保存できたのに未保存と誤認させない。例外は投げない)。
 */
export type PromptActionResult = { ok: true; id: string; refreshError?: string } | { ok: false; message: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 定型プロンプトのマスタ一覧の取得と変更。変更の後は一覧を取り直し、`onChanged` で
 * エージェントのカタログも取り直す (マスタの編集はエージェントの解決済みの値へ反映される)。
 * 取得は世代管理し、遅れて届いた応答が新しい一覧を巻き戻さないようにする。
 */
export function usePrompts({ onChanged }: { onChanged?: () => Promise<unknown> }): {
  state: PromptsState;
  /** 再取得中。取り直しのボタンを二重に押させない */
  reloading: boolean;
  /** 一覧とエージェントカタログを取り直す。失敗しても例外にせず、理由を状態へ残す */
  retry: () => void;
  /** 一覧とエージェントカタログを取り直し、失敗したらその理由で reject する（並べ替えの確定後） */
  refresh: () => Promise<void>;
  /** 並べ替えの確定順を、取り直しを待たずに現在の一覧へ反映する（組み込みは位置を保つ） */
  applyOrder: (ids: readonly string[]) => void;
  save: (id: string | undefined, draft: { label: string; prompt: string }) => Promise<PromptActionResult>;
  remove: (id: string) => Promise<PromptActionResult>;
} {
  const [state, setState] = useState<PromptsState>({ status: "loading", prompts: [] });
  const [reloading, setReloading] = useState(false);
  const [beginRequest] = useState(createRequestGate);
  const [tracker] = useState(() => createLoadingTracker(setReloading));

  useEffect(() => {
    const finish = tracker.begin();
    const canApply = beginRequest();
    void getPrompts()
      .then(({ prompts }) => {
        if (canApply()) setState({ status: "ready", prompts });
      })
      .catch((error: unknown) => {
        if (canApply()) {
          setState((prev) => ({ status: "error", prompts: prev.prompts, message: errorText(error) }));
        }
      })
      .finally(finish);
  }, [beginRequest, tracker]);

  /**
   * 変更後の取り直し。一覧とカタログを別々に試し、どちらが失敗したかを 1 つの文へまとめる。
   * `onChanged` の reject をここで止めるので、呼び出し側の busy 解除が飛ばされない。
   */
  const refreshAfterMutation = useCallback(async (): Promise<string | undefined> => {
    let listReason: string | undefined;
    let catalogReason: string | undefined;
    const canApply = beginRequest();
    try {
      const { prompts } = await getPrompts();
      if (canApply()) setState({ status: "ready", prompts });
    } catch (error) {
      const reason = errorText(error);
      listReason = reason;
      if (canApply()) setState((prev) => ({ status: "error", prompts: prev.prompts, message: reason }));
    }
    if (onChanged) {
      try {
        await onChanged();
      } catch (error) {
        catalogReason = errorText(error);
      }
    }
    return promptRefreshFailure(listReason, catalogReason);
  }, [beginRequest, onChanged]);

  const runRefresh = useCallback((): Promise<string | undefined> => {
    const finish = tracker.begin();
    return refreshAfterMutation().finally(finish);
  }, [refreshAfterMutation, tracker]);

  const refresh = useCallback(async (): Promise<void> => {
    const finish = tracker.begin();
    try {
      const failure = await refreshAfterMutation();
      // 並べ替えの確定後、保存は成立している。取り直しの失敗だけを理由として返す
      if (failure !== undefined) throw new Error(failure);
    } finally {
      finish();
    }
  }, [refreshAfterMutation, tracker]);

  const applyOrder = useCallback(
    (ids: readonly string[]) => {
      // 先行する取得の応答で確定順を巻き戻さない（client/src/hooks/requestGate.ts）
      beginRequest();
      setState((prev) => ({ ...prev, prompts: reorderRows(prev.prompts, ids) }));
    },
    [beginRequest],
  );

  return {
    state,
    reloading,
    retry: () => void runRefresh(),
    refresh,
    applyOrder,
    async save(id, draft) {
      let savedId: string;
      try {
        savedId = id ? (await updatePrompt(id, draft)).prompt.id : (await createPrompt(draft)).prompt.id;
      } catch (error) {
        return { ok: false, message: errorText(error) };
      }
      const refreshError = await runRefresh();
      return refreshError === undefined ? { ok: true, id: savedId } : { ok: true, id: savedId, refreshError };
    },
    async remove(id) {
      try {
        await deletePrompt(id);
      } catch (error) {
        return { ok: false, message: errorText(error) };
      }
      const refreshError = await runRefresh();
      return refreshError === undefined ? { ok: true, id } : { ok: true, id, refreshError };
    },
  };
}
