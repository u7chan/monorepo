/**
 * 設定 → 会話タイトルの表示変換と文言。DOM に依存しない純関数だけを置く。
 * 保存できる値の検証はサーバー (`PUT /api/settings/session-title`) が正で、ここは保存前に
 * 明らかな誤りを伝えるための写しを持つ (定義の上限はサーバーと揃える)。
 */
import type { ProviderBadge } from "./modelSettings";
import { effortLabel } from "./composerSettings";
import type { ThinkingLevel, TitleSummaryModelChoice, TitleSummarySettingsResponse } from "../types";

/** 定義の上限。サーバー (server/src/session-title.ts) と同じ値で、超える定義は保存できない */
export const TITLE_DEFINITION_MAX = 600;

/** 読み込み時の注記。再起動後も残ることを最初に伝える */
export const SESSION_TITLE_SETTINGS_NOTE =
  "会話タイトルの設定はサーバーに保存され、再起動後も残ります。過去の会話のタイトルは変わりません。";

/** 実行中の操作。null なら操作なし */
export type SessionTitleSavingAction = "enabled" | "model" | "effort" | "definition" | "reset";

/** AI 要約の状態。設定の他のページと同じチップで出す */
export function sessionTitleStatusBadge(enabled: boolean): ProviderBadge {
  return enabled ? { label: "AI要約 On", tone: "ok" } : { label: "AI要約 Off", tone: "warn" };
}

/** 定義の検証。空白だけ・上限超過は保存せず、同じ文言を画面に出す */
export function sessionTitleDefinitionError(definition: string): string | undefined {
  const trimmed = definition.trim();
  if (trimmed === "") return "要約の定義を入力してください。";
  if (trimmed.length > TITLE_DEFINITION_MAX) {
    return `要約の定義は${TITLE_DEFINITION_MAX}文字以内で入力してください。`;
  }
  return undefined;
}

/** モデル選択の値。未選択は空文字 (SelectMenu は文字列の value を要求する) */
export function sessionTitleModelValue(settings: Pick<TitleSummarySettingsResponse, "model">): string {
  return settings.model ?? "";
}

export interface SessionTitleModelOption {
  value: string;
  label: string;
  detail: string;
  group: string;
}

/** 要約モデルの選択肢。本会話のモデルとは独立で、ここで選んだモデルだけを使う */
export function sessionTitleModelOptions(models: readonly TitleSummaryModelChoice[]): SessionTitleModelOption[] {
  return models.map((model) => ({
    value: `${model.provider}/${model.id}`,
    label: model.name,
    detail: model.id,
    group: model.provider,
  }));
}

/** 保存済みモデルが候補に無いときの警告。本会話のモデルへは切り替えない */
export function sessionTitleModelUnavailableNotice(
  settings: Pick<TitleSummarySettingsResponse, "model" | "modelAvailable">,
): string | undefined {
  if (!settings.model || settings.modelAvailable) return undefined;
  return "選択したモデルは現在利用できません。タイトルの AI 要約だけを飛ばし、会話の送信は続けます。";
}

/** 要約モデル / Effort の保存後の注記。On/Off の注記と混ぜない */
export const SESSION_TITLE_MODEL_SAVED_NOTE = "要約モデルを保存しました。";
export const SESSION_TITLE_EFFORT_SAVED_NOTE = "Effortを保存しました。";

export const SESSION_TITLE_ENABLED_NOTE = "AI要約 On";
export const SESSION_TITLE_DISABLED_NOTE = "AI要約 Off";

/** 保存後の注記。Off でもモデルと定義を保持することを伝える */
export function sessionTitleSavedNote(settings: Pick<TitleSummarySettingsResponse, "enabled">): string {
  return settings.enabled
    ? "会話タイトルの AI 要約を有効にしました。次に本文ありの会話が正常完了したときに 1 回だけ要約します。"
    : "会話タイトルの AI 要約を無効にしました。モデルと定義は保持しています。";
}

/** Effort の選択値。実効値が無い (モデル未選択 / 候補なし) は空文字 */
export function sessionTitleEffortValue(
  settings: Pick<TitleSummarySettingsResponse, "effectiveThinkingLevel">,
): ThinkingLevel | "" {
  return settings.effectiveThinkingLevel ?? "";
}

export interface SessionTitleEffortOption {
  value: ThinkingLevel;
  label: string;
  description?: string;
  disabled?: boolean;
}

/** 選択中の要約モデルが対応する Effort だけを返す */
export function sessionTitleEffortOptions(
  settings: Pick<TitleSummarySettingsResponse, "model" | "models" | "effectiveThinkingLevel">,
): SessionTitleEffortOption[] {
  const selected = settings.models.find((model) => `${model.provider}/${model.id}` === settings.model);
  const levels = selected?.thinkingLevels ?? [];
  const options: SessionTitleEffortOption[] = levels.map((level) => ({ value: level, label: effortLabel(level) }));
  const effective = settings.effectiveThinkingLevel;
  // 保存済み Effort がモデルの候補から消えた場合も、現在値を見失わないよう無効行として残す
  if (effective && !levels.includes(effective)) {
    options.unshift({
      value: effective,
      label: effortLabel(effective),
      description: "このモデルでは選べません",
      disabled: true,
    });
  }
  return options;
}

/** モデルを切り替えたときに選ぶ Effort。現在値が新モデルでも使えるなら残し、無理なら最小段階へ */
export function sessionTitleEffortForModel(
  settings: Pick<TitleSummarySettingsResponse, "model" | "models" | "effectiveThinkingLevel">,
  model: string,
  current: ThinkingLevel | null,
): ThinkingLevel | null {
  const selected = settings.models.find((candidate) => `${candidate.provider}/${candidate.id}` === model);
  if (!selected) return null;
  if (current !== null && selected.thinkingLevels.includes(current)) return current;
  return selected.thinkingLevels[0] ?? null;
}

/** 保存済み Effort がモデルの対応段階から外れたときの警告。実行時は最小段階へフォールバックする */
export function sessionTitleEffortNotice(
  settings: Pick<TitleSummarySettingsResponse, "thinkingLevel" | "effectiveThinkingLevel">,
): string | undefined {
  if (settings.thinkingLevel === null || settings.effectiveThinkingLevel === null) return undefined;
  if (settings.thinkingLevel === settings.effectiveThinkingLevel) return undefined;
  return "保存済みの Effort は現在のモデルで利用できないため、既定の Effort を使います。";
}

export const SESSION_TITLE_DEFINITION_SAVED_NOTE = "要約の定義を保存しました。";

export const SESSION_TITLE_DEFINITION_RESET_NOTE = "要約の定義を既定文へ戻しました。";
