/**
 * 設定 → 会話タイトルの表示変換と文言。DOM に依存しない純関数だけを置く。
 * 保存できる値の検証はサーバー (`PUT /api/settings/session-title`) が正で、ここは保存前に
 * 明らかな誤りを伝えるための写しを持つ (定義の上限はサーバーと揃える)。
 */
import type { ProviderBadge } from "./modelSettings";
import type { TitleSummaryModelChoice, TitleSummarySettingsResponse } from "../types";

/** 定義の上限。サーバー (server/src/session-title.ts) と同じ値で、超える定義は保存できない */
export const TITLE_DEFINITION_MAX = 600;

/** 読み込み時の注記。再起動後も残ることを最初に伝える */
export const SESSION_TITLE_SETTINGS_NOTE =
  "会話タイトルの設定はサーバーに保存され、再起動後も残ります。過去の会話のタイトルは変わりません。";

/** 実行中の操作。null なら操作なし */
export type SessionTitleSavingAction = "enabled" | "model" | "definition" | "reset";

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

export const SESSION_TITLE_ENABLED_NOTE = "AI要約 On";
export const SESSION_TITLE_DISABLED_NOTE = "AI要約 Off";

/** 保存後の注記。Off でもモデルと定義を保持することを伝える */
export function sessionTitleSavedNote(settings: Pick<TitleSummarySettingsResponse, "enabled">): string {
  return settings.enabled
    ? "会話タイトルの AI 要約を有効にしました。次に本文ありの会話が正常完了したときに 1 回だけ要約します。"
    : "会話タイトルの AI 要約を無効にしました。モデルと定義は保持しています。";
}

export const SESSION_TITLE_DEFINITION_SAVED_NOTE = "要約の定義を保存しました。";

export const SESSION_TITLE_DEFINITION_RESET_NOTE = "要約の定義を既定文へ戻しました。";
