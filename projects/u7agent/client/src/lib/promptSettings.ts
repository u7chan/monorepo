/**
 * 定型プロンプトのマスタ (設定 → 定型プロンプト、`/settings/prompts`) と、エージェントからの参照
 * (選択・解除・並べ替え) の純粋なロジック。表示の同一性はマスタの `id` で持ち、同じ本文の別マスタを
 * 本文でまとめない (docs/api-catalog.md)。
 */
import type { AgentDef, PromptDef, PromptUsage } from "../types";

/** サーバーの検証と同じ上限。入力欄の `maxLength` と残量の表示に使う */
export const PROMPT_LABEL_MAX = 60;
export const PROMPT_TEXT_MAX = 500;
/** エージェント 1 体が参照できるマスタの上限 (マスタ全体には上限を掛けない) */
export const AGENT_PROMPT_LIMIT = 6;

export const PROMPT_LIST_EMPTY_NOTE = "条件に合う定型プロンプトがありません。";
export const BUILTIN_PROMPT_READONLY_NOTE =
  "組み込みの定型プロンプトは編集・削除できません。変更したい内容は自作として登録してください。";
export const AGENT_PROMPT_SELECT_LIMIT_NOTE = `追加できるのは ${AGENT_PROMPT_LIMIT} 件までです。`;
export const AGENT_PROMPT_SELECT_EMPTY_NOTE =
  "まだ選択していません。設定 → 定型プロンプトで登録したマスタを選ぶと、空の会話にボタンとして出ます。";

export type PromptDraft = { label: string; prompt: string };

/** 下書きはページが持つ。選択対象から初期値を作る (ビルトインは閲覧のみなので下書きも作らない) */
export function promptDraftOf(prompt: PromptDef | undefined): PromptDraft {
  return { label: prompt?.label ?? "", prompt: prompt?.prompt ?? "" };
}

/** 下書きの同一性。参照ではなく内容で比べ、同じ内容の取り直しで入力中の未保存の値を消さない */
export function promptDraftKey(draft: PromptDraft): string {
  return JSON.stringify(draft);
}

export function isPromptDraftDirty(draft: PromptDraft, prompt: PromptDef | undefined): boolean {
  return promptDraftKey(draft) !== promptDraftKey(promptDraftOf(prompt));
}

/** 保存前の検証。サーバーも同じ条件で 400 にするが、押せない理由を先に読めるようにする */
export function promptDraftError(draft: PromptDraft): string | undefined {
  if (draft.label.trim() === "") return "ラベルを入力してください。";
  if (draft.prompt.trim() === "") return "プロンプトを入力してください。";
  return undefined;
}

/** 保存ペイロード。trim はサーバーも行うが、前後の空白を残したまま差分表示しないようここで揃える */
export function promptPayloadOf(draft: PromptDraft): PromptDraft {
  return { label: draft.label.trim(), prompt: draft.prompt.trim() };
}

/** 使用先の 1 行。組み込みの汎用アシスタントは DB の紐づけではないことを添える */
export function promptUsageLabel(usage: PromptUsage): string {
  return usage.builtin ? `${usage.agentName}（組み込み）` : usage.agentName;
}

/** 使用中の削除を止める理由。空なら削除できる */
export function promptDeleteBlockedReason(prompt: PromptDef): string | undefined {
  if (prompt.kind === "builtin") return BUILTIN_PROMPT_READONLY_NOTE;
  if (prompt.usedBy.length === 0) return undefined;
  const names = prompt.usedBy.map(promptUsageLabel).join("、");
  return `${names} が使用中です。すべての紐づけを解除すると削除できます。`;
}

/** 組み込みと自作の区別。一覧の見出しと絞り込みに使う */
export function splitPromptsByKind(prompts: readonly PromptDef[]): {
  builtin: PromptDef[];
  custom: PromptDef[];
} {
  return {
    builtin: prompts.filter((prompt) => prompt.kind === "builtin"),
    custom: prompts.filter((prompt) => prompt.kind === "custom"),
  };
}

/** エージェントが参照しているマスタの ID (表示順) */
export function promptSelectionOf(agent: AgentDef | undefined): string[] {
  return agent?.prompts?.map((prompt) => prompt.id) ?? [];
}

/**
 * 参照の候補。マスタの一覧をそのまま出し、選択済みは呼び出し側が `promptSelectionOf` で重ねる。
 * 一覧を取得できていない間は空 (選択肢を勝手に作らない)。
 */
export function promptCandidates(prompts: readonly PromptDef[]): PromptDef[] {
  return [...prompts];
}

/** 上限に達しているか (新規の追加を止める理由の判定) */
export function atPromptLimit(ids: readonly string[]): boolean {
  return ids.length >= AGENT_PROMPT_LIMIT;
}

/** 追加。上限と重複は無視する (UI は押せないが、二重送信でも選択が壊れないようにする) */
export function withPromptSelected(ids: readonly string[], id: string): string[] {
  if (ids.includes(id) || atPromptLimit(ids)) return [...ids];
  return [...ids, id];
}

/** 解除。マスタ自体は消さない (削除はマスタの独立画面の操作) */
export function withPromptRemoved(ids: readonly string[], id: string): string[] {
  return ids.filter((entry) => entry !== id);
}

/** 並べ替え。端では動かさない (位置は 1..6 の範囲に閉じる) */
export function withPromptMoved(ids: readonly string[], id: string, delta: -1 | 1): string[] {
  const index = ids.indexOf(id);
  if (index < 0) return [...ids];
  const next = index + delta;
  if (next < 0 || next >= ids.length) return [...ids];
  const result = [...ids];
  result[index] = ids[next];
  result[next] = id;
  return result;
}
