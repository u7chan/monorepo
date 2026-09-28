/**
 * 設定 → モデル（画像生成タブ）の表示変換。DOM に依存しない純関数だけを置き、
 * 選択肢の組み立て・入力の後始末・保存後の文言・確認文をテストできるようにする。
 */
import type { ImageSettingsResponse, ModelRef, UpdateImageSelectionBody } from "../types";
import { modelRefKey } from "./modelSettings";

/** 画像生成タブの初期注記。キーの有無に関わらず出す */
export const IMAGE_SETTINGS_NOTE = "画像生成の設定はサーバーに保存され、再起動後も残ります。";

export const IMAGE_KEY_SAVED_NOTE = "画像APIキーを保存しました。新しい会話から generate_image を使えます。";
export const IMAGE_KEY_DELETED_NOTE = "画像APIキーを削除しました。generate_image は新しい会話から使えません。";
export const IMAGE_MODEL_SAVED_NOTE = "画像生成のモデルを保存しました。";

/** 実行中の操作。null なら操作なし */
export type ImageSavingAction = "key" | "delete" | "selection";

export interface ImageModelOption {
  /** 選択欄の値。`provider/id` 表記 */
  value: string;
  label: string;
  /** PUT の本文を作るための参照。provider を決められない保存値では null */
  model: ModelRef | null;
}

/**
 * モデル選択の選択肢。カタログをそのまま並べ、保存済みのモデルがカタログに無ければ現在の id を
 * 「（カタログ外）」として先頭に足す (何が保存されているかを見失わせない)。name は DTO 上は空を許すため、
 * 表示名に使えないときと、同じ name が複数あるときは id を添えて一意にする。
 */
export function imageModelOptions(
  settings: Pick<ImageSettingsResponse, "provider" | "model" | "models">,
): ImageModelOption[] {
  const nameCounts = new Map<string, number>();
  for (const entry of settings.models) {
    if (entry.name === "") continue;
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }
  const options: ImageModelOption[] = settings.models.map((entry) => ({
    value: modelRefKey({ provider: entry.provider, id: entry.id }),
    label: optionLabel(entry, (nameCounts.get(entry.name) ?? 0) > 1),
    model: { provider: entry.provider, id: entry.id },
  }));
  if (
    settings.provider !== null &&
    settings.model !== null &&
    !options.some((option) => option.model?.id === settings.model)
  ) {
    const model = { provider: settings.provider, id: settings.model };
    options.unshift({
      value: modelRefKey(model),
      label: `${settings.model}（カタログ外）`,
      model,
    });
  }
  return options;
}

/** 選択肢の表示名。name が空なら id だけ、同じ name が複数あるときは id を添えて一意にする */
function optionLabel(entry: { id: string; name: string }, duplicated: boolean): string {
  if (entry.name === "") return entry.id;
  return duplicated ? `${entry.name}（${entry.id}）` : entry.name;
}

/** 選択欄の現在値。行が無い (未設定) か provider を決められないときは空文字 */
export function imageModelValue(settings: Pick<ImageSettingsResponse, "provider" | "model">): string {
  if (settings.provider === null || settings.model === null) return "";
  return modelRefKey({ provider: settings.provider, id: settings.model });
}

/** 選択中の選択肢を PUT の本文へ。provider を決められないときは null (保存させない) */
export function imageModelSelection(options: ImageModelOption[], value: string): UpdateImageSelectionBody | null {
  const option = options.find((entry) => entry.value === value);
  return option?.model ? { provider: option.model.provider, model: option.model.id } : null;
}

/** キー入力の後始末。保存できたときだけ空へ戻し、失敗時は再入力を避けて残す */
export function keyDraftAfterSave(draft: string, saved: boolean): string {
  return saved ? "" : draft;
}

/** 削除の確認。新しい会話で使えなくなることと、既存の会話で実行時に失敗することを先に伝える */
export function deleteImageKeyConfirmMessage(): string {
  return "画像APIキーを削除します。generate_image は新しい会話で使えなくなり、既存の会話で実行するとキー無効エラーになります。よろしいですか？";
}
