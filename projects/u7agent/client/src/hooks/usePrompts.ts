import { useCallback, useEffect, useState } from "react";
import { createPrompt, deletePrompt, getPrompts, updatePrompt } from "../api";
import type { PromptDef } from "../types";
import { createRequestGate } from "./requestGate";

/** 一覧の取得状態。読み込み中 / 取得済み / 失敗を区別し、空の一覧と混同しない */
export type PromptsState =
  | { status: "loading" }
  | { status: "ready"; prompts: PromptDef[] }
  | { status: "error"; message: string };

/** 保存 / 削除の結果。失敗したら画面は下書きを残し、成功として扱わない */
export type PromptActionResult = { ok: true } | { ok: false; message: string };

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
  reload: () => void;
  save: (id: string | undefined, draft: { label: string; prompt: string }) => Promise<PromptActionResult>;
  remove: (id: string) => Promise<PromptActionResult>;
} {
  const [state, setState] = useState<PromptsState>({ status: "loading" });
  const [beginRequest] = useState(createRequestGate);

  const load = useCallback(async () => {
    const canApply = beginRequest();
    try {
      const { prompts } = await getPrompts();
      if (canApply()) setState({ status: "ready", prompts });
    } catch (error) {
      if (canApply()) setState({ status: "error", message: errorText(error) });
    }
  }, [beginRequest]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 一覧を先に取り直してから、カタログの再取得を待つ (順序はどちらも「サーバーの正を写す」) */
  const refreshAll = useCallback(async () => {
    await load();
    await onChanged?.();
  }, [load, onChanged]);

  return {
    state,
    reload: () => void load(),
    async save(id, draft) {
      try {
        if (id) await updatePrompt(id, draft);
        else await createPrompt(draft);
      } catch (error) {
        return { ok: false, message: errorText(error) };
      }
      await refreshAll();
      return { ok: true };
    },
    async remove(id) {
      try {
        await deletePrompt(id);
      } catch (error) {
        return { ok: false, message: errorText(error) };
      }
      await refreshAll();
      return { ok: true };
    },
  };
}
