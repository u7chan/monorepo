/**
 * 設定 → モデルの「カスタムプロバイダー」の表示・入力検証・文言。コンポーネントから切り出し、
 * 保存前の検証と、オンメモリであることの注意書きを DOM なしで固定できるようにする。
 * サーバーの検証 (server/src/custom-providers.ts) と同じ境界を、保存前に同じ理由で止めるために持つ。
 */
import type { CreateCustomProviderBody, CustomProviderSummary, UpdateCustomProviderBody } from "../types";
import type { ConfirmRequest } from "./confirmDialog";

export const CUSTOM_PROVIDER_ID_MAX_LENGTH = 64;
export const CUSTOM_PROVIDER_NAME_MAX_LENGTH = 64;
export const CUSTOM_PROVIDER_BASE_URL_MAX_LENGTH = 2_048;
export const CUSTOM_PROVIDER_MODEL_ID_MAX_LENGTH = 200;
export const CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS = 16_384;
export const CUSTOM_PROVIDER_CONTEXT_WINDOW_PLACEHOLDER = "32768";

/** サーバーと同じ id の形。作成後は変更できない */
export const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export const CUSTOM_PROVIDER_SECTION_TITLE = "カスタムプロバイダー";
export const CUSTOM_PROVIDER_ADD_LABEL = "カスタムプロバイダーを追加";
export const CUSTOM_PROVIDER_MEMORY_BADGE = "メモリのみ";
export const CUSTOM_PROVIDER_CREATED_NOTE = "カスタムプロバイダーを登録しました。モデル候補を更新しています。";
export const CUSTOM_PROVIDER_UPDATED_NOTE = "カスタムプロバイダーを更新しました。モデル候補を更新しています。";
export const CUSTOM_PROVIDER_DELETED_NOTE = "カスタムプロバイダーを削除しました。モデル候補を更新しています。";

/**
 * 専用セクションに常時出す注意。オンメモリであることと、再起動後に残るモデル選択の扱いを先に伝える。
 * 長い理由は docs/model-settings.md に置き、画面は短い注意だけを持つ。
 * 一覧の左列では場所を取るため既定で畳み、この 1 行だけを出しておく。
 */
export const CUSTOM_PROVIDER_NOTES_SUMMARY = "BFF のメモリにだけ保存されます。再起動すると定義とAPIキーは消えます。";

export const CUSTOM_PROVIDER_NOTES: readonly string[] = [
  "再起動後、利用可能なモデルに残ったカスタムモデルはカタログ外になり、外すまでモデルの選択を保存できません。同じ provider id とモデル id で再登録すれば、選択は再び有効になります。",
  "アプリ既定モデルにカスタムモデルを指定している場合、再起動後は既定モデルを解決できないため、新しい会話を始められません。",
  "APIキーは必須です。認証のないローカルサーバーには 8 文字以上のダミーを入れてください（Authorization: Bearer <キー> として送られます）。",
  "BFF にはログインがないため、信頼できる baseUrl だけを指定してください。",
];

/** contextWindow の入力の注意。実モデルより大きい値を入れると、送信がコンテキスト超過で失敗する */
export const CUSTOM_PROVIDER_CONTEXT_WINDOW_NOTE = "実モデルの context window より大きくしないでください。";

/** フォームの下書き。数値は入力欄の文字列のまま持ち、保存前に検証する */
export interface CustomProviderFormDraft {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  contextWindow: string;
  maxTokens: string;
}

export function emptyCustomProviderDraft(): CustomProviderFormDraft {
  return {
    id: "",
    name: "",
    baseUrl: "",
    apiKey: "",
    modelId: "",
    contextWindow: "",
    maxTokens: String(CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS),
  };
}

/** 保存値から編集用の下書きを作る。キーは応答に載らないため常に空 (= 空欄なら既存を維持) */
export function customProviderDraftOf(summary: CustomProviderSummary): CustomProviderFormDraft {
  return {
    id: summary.id,
    name: summary.name === summary.id ? "" : summary.name,
    baseUrl: summary.baseUrl,
    apiKey: "",
    modelId: summary.model.id,
    contextWindow: String(summary.model.contextWindow),
    maxTokens: String(summary.model.maxTokens),
  };
}

export interface CustomProviderFormErrors {
  id?: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
  contextWindow?: string;
  maxTokens?: string;
}

function isPositiveIntegerText(value: string): boolean {
  return /^\d+$/u.test(value) && Number(value) > 0;
}

/** baseUrl の検証 (server の normalizeCustomProviderBaseUrl と同じ規則) */
export function customProviderBaseUrlError(value: string): string | undefined {
  const raw = value.trim();
  if (raw === "") return "baseUrl を入力してください。";
  if (raw.length > CUSTOM_PROVIDER_BASE_URL_MAX_LENGTH) {
    return `baseUrl は ${CUSTOM_PROVIDER_BASE_URL_MAX_LENGTH} 文字以内で入力してください。`;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "baseUrl は http / https の URL を入力してください。";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "baseUrl は http / https の URL を入力してください。";
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    return "baseUrl に userinfo・query・fragment は指定できません。";
  }
  if (parsed.hostname === "") return "baseUrl は http / https の URL を入力してください。";
  return undefined;
}

/** APIキーの検証。作成時は必須、編集時は空欄 = 既存を維持なので、入力があるときだけ長さを見る */
export function customProviderApiKeyError(value: string, editing: boolean): string | undefined {
  if (value === "") return editing ? undefined : "APIキーを入力してください。";
  if (value.length < 8) return "APIキーは 8 文字以上で入力してください。";
  if (value.length > 2_048) return "APIキーは 2048 文字以内で入力してください。";
  return undefined;
}

/**
 * 保存前の検証。編集時は id を変更できないので、形の検証もしない (表示は読み取り専用)。
 * 空白だけのモデル ID はサーバーと同じく拒否する。
 */
export function validateCustomProviderDraft(
  draft: CustomProviderFormDraft,
  options: { editing: boolean },
): CustomProviderFormErrors {
  const errors: CustomProviderFormErrors = {};
  const id = draft.id.trim();
  if (!options.editing) {
    if (id === "") errors.id = "provider id を入力してください。";
    else if (!CUSTOM_PROVIDER_ID_PATTERN.test(id) || id.length > CUSTOM_PROVIDER_ID_MAX_LENGTH) {
      errors.id = "英小文字で始まり、英小文字・数字・ハイフンのみ 64 文字以内で入力してください。";
    }
  }
  if (draft.name.trim().length > CUSTOM_PROVIDER_NAME_MAX_LENGTH) {
    errors.name = `名前は ${CUSTOM_PROVIDER_NAME_MAX_LENGTH} 文字以内で入力してください。`;
  }
  const baseUrl = customProviderBaseUrlError(draft.baseUrl);
  if (baseUrl) errors.baseUrl = baseUrl;

  const apiKey = customProviderApiKeyError(draft.apiKey, options.editing);
  if (apiKey) errors.apiKey = apiKey;

  const modelId = draft.modelId.trim();
  if (modelId === "") errors.modelId = "モデル ID を入力してください。";
  else if (modelId.length > CUSTOM_PROVIDER_MODEL_ID_MAX_LENGTH || /\s/u.test(modelId)) {
    errors.modelId = `モデル ID は空白なしで ${CUSTOM_PROVIDER_MODEL_ID_MAX_LENGTH} 文字以内で入力してください。`;
  }

  if (draft.contextWindow.trim() === "") errors.contextWindow = "contextWindow を入力してください。";
  else if (!isPositiveIntegerText(draft.contextWindow.trim())) {
    errors.contextWindow = "contextWindow は正の整数で入力してください。";
  }

  const maxTokens = draft.maxTokens.trim();
  if (maxTokens !== "" && !isPositiveIntegerText(maxTokens)) {
    errors.maxTokens = "maxTokens は正の整数で入力してください。";
  }
  return errors;
}

export function customProviderFormHasError(errors: CustomProviderFormErrors): boolean {
  return Object.values(errors).some((error) => error !== undefined);
}

/** サーバーへ送るモデル。maxTokens は空欄なら送らず、既定をサーバーに決めさせる */
function modelBodyOf(draft: CustomProviderFormDraft): {
  id: string;
  contextWindow: number;
  maxTokens?: number;
} {
  const maxTokens = draft.maxTokens.trim();
  return {
    id: draft.modelId.trim(),
    contextWindow: Number(draft.contextWindow.trim()),
    ...(maxTokens === "" ? {} : { maxTokens: Number(maxTokens) }),
  };
}

export function customProviderCreateBody(draft: CustomProviderFormDraft): CreateCustomProviderBody {
  const name = draft.name.trim();
  return {
    id: draft.id.trim(),
    ...(name === "" ? {} : { name }),
    baseUrl: draft.baseUrl.trim(),
    apiKey: draft.apiKey,
    model: modelBodyOf(draft),
  };
}

/** 更新の本文。キーの空欄は既存を維持するため、キー自体を送らない */
export function customProviderUpdateBody(draft: CustomProviderFormDraft): UpdateCustomProviderBody {
  const name = draft.name.trim();
  return {
    ...(name === "" ? {} : { name }),
    baseUrl: draft.baseUrl.trim(),
    ...(draft.apiKey === "" ? {} : { apiKey: draft.apiKey }),
    model: modelBodyOf(draft),
  };
}

/** 削除の確認。既存の会話への影響と、モデル選択が外れることを先に伝える */
export function deleteCustomProviderConfirm(name: string): ConfirmRequest {
  return {
    kind: "confirm",
    title: "カスタムプロバイダーを削除",
    subject: { label: "削除する provider", value: name },
    body: [
      "この定義とAPIキーは BFF のメモリから消えます（DB には保存していません）。",
      "この provider のモデルを使っている会話は、次回の送信が失敗することがあります。",
      "利用可能なモデルに残ったカスタムモデルはカタログ外になるため、「モデルを選ぶ」タブで外すまで保存できません。",
    ],
    confirmLabel: "削除する",
    danger: true,
  };
}
