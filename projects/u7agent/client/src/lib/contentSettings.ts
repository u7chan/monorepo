/**
 * 設定 → モデル（コンテンツ生成タブ）の表示変換。DOM に依存しない純関数だけを置き、
 * 選択肢の組み立て・入力の後始末・保存後の文言・確認文をテストできるようにする。
 */
import type {
  ContentImageSettings,
  ContentSettingsResponse,
  ContentSpeechSettings,
  ModelRef,
  SpeechCatalogRefreshResponse,
  SpeechModel,
  UpdateContentImageBody,
  UpdateContentSpeechBody,
} from "../types";
import type { ConfirmRequest } from "./confirmDialog";
import { messageTimeLabel, type MessageTimeOptions } from "./messageTime";
import { modelRefKey, type ProviderBadge } from "./modelSettings";

/** コンテンツ生成タブの初期注記。キーの有無に関わらず出す */
export const CONTENT_SETTINGS_NOTE = "コンテンツ生成の設定はサーバーに保存され、再起動後も残ります。";

export const CONTENT_KEY_SAVED_NOTE =
  "コンテンツ生成のAPIキーを保存しました。新しい会話から generate_image と generate_speech を使えます。";
export const CONTENT_KEY_DELETED_NOTE =
  "コンテンツ生成のAPIキーを削除しました。generate_image と generate_speech は新しい会話から使えません。";
export const CONTENT_MODEL_SAVED_NOTE = "画像生成のモデルを保存しました。";
export const CONTENT_SPEECH_SAVED_NOTE = "音声生成のモデルとボイスを保存しました。";

/** 音声カタログ更新後に現在値を確認できなかったときの注記。確認できるまで音声の設定を保存させない */
export const SPEECH_SYNC_FAILED_NOTE =
  "音声モデル一覧は取得しましたが、現在の設定を確認できませんでした。再読み込みするまで音声の設定は保存できません。";

/** 実行中の操作。null なら操作なし */
export type ContentSavingAction = "key" | "delete" | "selection" | "catalog" | "speech" | "speech-catalog";

/** APIキーの登録状態バッジ。同じ意味の表示をプロバイダータブと同じ見た目で揃える */
export function contentKeyStatusBadge(configured: boolean): ProviderBadge {
  return configured ? { label: "設定済み", tone: "ok" } : { label: "未設定", tone: "muted" };
}

/** 未設定 (行が無い) のときに見せる provider。画像 / 音声で共有し、サーバーが既定行を作る provider と同じにする */
const DEFAULT_CONTENT_PROVIDER = "openrouter";

/** 見出しのロゴを引く id。未設定でも、これから登録するキーの provider を出す */
export function contentProviderId(provider: string | null): string {
  return provider ?? DEFAULT_CONTENT_PROVIDER;
}

/** provider の表示名。v1 は openrouter だけなので id のまま出さず、既知の provider は名前へ寄せる */
export function contentProviderLabel(provider: string | null): string {
  const id = contentProviderId(provider);
  return id === DEFAULT_CONTENT_PROVIDER ? "OpenRouter" : id;
}

/**
 * モデル一覧の出どころ。取得できなかったことと、いまどちらの一覧を見ているかを 1 行で示す。
 * `fetchedAt` は live / stored のときだけ意味を持ち、SDK 同梱では出さない。
 */
export function imageCatalogNotice(
  settings: Pick<ContentImageSettings, "catalogSource" | "fetchedAt">,
  options: MessageTimeOptions = {},
): string {
  const at = settings.fetchedAt === null ? "" : `（最終取得: ${messageTimeLabel(settings.fetchedAt, options)}）`;
  switch (settings.catalogSource) {
    case "live":
      return `モデル一覧は OpenRouter から取得しました${at}`;
    case "stored":
      return `OpenRouter から取得できなかったため、前回の一覧を表示しています${at}`;
    case "sdk":
      return "OpenRouter から取得できていないため、SDK の組み込み一覧を表示しています";
  }
}

/** [再取得] の結果。失敗しても一覧は前のまま残るので、変わらないことを文言で伝える（画像 / 音声で同じ） */
export function catalogRefreshNote(catalogError: string | null): string {
  return catalogError === null ? "モデル一覧を取得しました。" : `${catalogError}。表示中の一覧は変わりません。`;
}

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
export function imageModelOptions(settings: Pick<ContentSettingsResponse, "provider" | "image">): ImageModelOption[] {
  const { provider, image } = settings;
  const nameCounts = new Map<string, number>();
  for (const entry of image.models) {
    if (entry.name === "") continue;
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }
  const options: ImageModelOption[] = image.models.map((entry) => ({
    value: modelRefKey({ provider: entry.provider, id: entry.id }),
    label: optionLabel(entry, (nameCounts.get(entry.name) ?? 0) > 1),
    model: { provider: entry.provider, id: entry.id },
  }));
  if (provider !== null && image.model !== null && !options.some((option) => option.model?.id === image.model)) {
    const model = { provider, id: image.model };
    options.unshift({
      value: modelRefKey(model),
      label: `${image.model}（カタログ外）`,
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
export function imageModelValue(settings: Pick<ContentSettingsResponse, "provider" | "image">): string {
  if (settings.provider === null || settings.image.model === null) return "";
  return modelRefKey({ provider: settings.provider, id: settings.image.model });
}

/**
 * 音声モデル一覧の出どころ。`default` は「live もキャッシュも無く、同梱の 1 件を見ている」を表す
 * （docs/speech-generation.md）。画像の `sdk` と同じ位置付けだが、同梱が SDK ではなく 1 件なので別名。
 */
export function speechCatalogNotice(
  settings: Pick<ContentSpeechSettings, "catalogSource" | "fetchedAt">,
  options: MessageTimeOptions = {},
): string {
  const at = settings.fetchedAt === null ? "" : `（最終取得: ${messageTimeLabel(settings.fetchedAt, options)}）`;
  switch (settings.catalogSource) {
    case "live":
      return `音声モデル一覧は OpenRouter から取得しました${at}`;
    case "stored":
      return `OpenRouter から取得できなかったため、前回の音声モデル一覧を表示しています${at}`;
    case "default":
      return "OpenRouter から取得できていないため、同梱の既定の音声モデルを表示しています";
  }
}

export interface SpeechModelOption {
  /** 選択欄の値。音声の provider は v1 では openrouter 固定なので id だけを使う */
  value: string;
  label: string;
  /** PUT の本文を作るための参照。カタログ外の保存値では id だけを持つ合成エントリ */
  model: SpeechModel | null;
}

/**
 * 音声モデルの選択肢。画像と同じくカタログ順に並べ、保存済みのモデルがカタログに無ければ現在の id を
 * 「（カタログ外）」として先頭に足す。
 */
export function speechModelOptions(
  settings: Pick<ContentSettingsResponse, "provider" | "speech">,
): SpeechModelOption[] {
  const { provider, speech } = settings;
  const nameCounts = new Map<string, number>();
  for (const entry of speech.models) {
    if (entry.name === "") continue;
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }
  const options: SpeechModelOption[] = speech.models.map((entry) => ({
    value: entry.id,
    label: optionLabel(entry, (nameCounts.get(entry.name) ?? 0) > 1),
    model: entry,
  }));
  if (speech.model !== null && !options.some((option) => option.value === speech.model)) {
    options.unshift({
      value: speech.model,
      label: `${speech.model}（カタログ外）`,
      model: { provider: provider ?? DEFAULT_CONTENT_PROVIDER, id: speech.model, name: "" },
    });
  }
  return options;
}

/** 選択欄の現在値。行が無い (未設定) ときは空文字 */
export function speechModelValue(settings: Pick<ContentSettingsResponse, "speech">): string {
  return settings.speech.model ?? "";
}

/** 選択中のモデルとボイスを PUT の本文へ。選択肢に無い値は null (保存させない) */
export function speechSelection(
  options: SpeechModelOption[],
  value: string,
  voice: string,
): UpdateContentSpeechBody | null {
  const option = options.find((entry) => entry.value === value);
  return option?.model ? { model: option.model.id, voice } : null;
}

/**
 * 宣言があるモデルは選択 (宣言が無いモデルは自由記述)。モデルを切り替えたときの欄の種類もここで決まる。
 */
export function speechVoiceMode(option: SpeechModelOption | undefined): "select" | "text" {
  return option?.model?.voices && option.model.voices.length > 0 ? "select" : "text";
}

/**
 * ボイス欄の値。保存値が選択中モデルの宣言に含まれれば維持し、宣言外（live の更新で顔ぶれが変わった後）なら
 * 先頭へ寄せる。宣言が無いモデルは自由記述なので保存値のまま（空文字は「送らない」を表す）。
 */
export function speechVoiceValue(option: SpeechModelOption | undefined, savedVoice: string): string {
  const voices = option?.model?.voices;
  if (!voices || voices.length === 0) return savedVoice;
  return voices.includes(savedVoice) ? savedVoice : voices[0];
}

/** モデル切替時の既定ボイス。新しいモデルが宣言する先頭へ寄せ、宣言が無ければ空（送らない） */
export function speechDefaultVoice(option: SpeechModelOption | undefined): string {
  return option?.model?.voices?.[0] ?? "";
}

/**
 * ボイス欄の値。入力中の値 →（モデルを切り替えた直後は新しいモデルの既定）→ 保存値の順に決める。
 * 切替時に旧モデルのボイスを持ち越さないことを 1 箇所に閉じる。
 */
export function speechVoiceDraft(input: {
  draft: string | null;
  modelChanged: boolean;
  option: SpeechModelOption | undefined;
  savedVoice: string;
}): string {
  if (input.draft !== null) return input.draft;
  return input.modelChanged ? speechDefaultVoice(input.option) : speechVoiceValue(input.option, input.savedVoice);
}

/**
 * 音声カタログ再取得後の状態。一覧の並びが変わると NULL ボイスのフォールバック（先頭）も変わるため、
 * server の現在値（GET）が取れていればそれを正とし、取れなかったときだけ一覧の項目を差し替える。
 * 差し替えた状態を現在値とみなすかは `speechSyncedAfterRefresh` が決める（確認できない間は
 * 「（未確認）」として保存を止める）。
 */
export function speechSettingsAfterRefresh(
  previous: ContentSettingsResponse | null,
  refreshed: Pick<SpeechCatalogRefreshResponse, "models" | "catalogSource" | "fetchedAt">,
  current: ContentSettingsResponse | null,
): ContentSettingsResponse | null {
  if (current !== null) return current;
  return previous === null ? null : { ...previous, speech: { ...previous.speech, ...refreshed } };
}

/**
 * 再取得後に server の実効値を確認できたか。一覧が変わった（取得に成功した）のに現在値を取れない間は、
 * 旧い表示を現在値とみなさず、音声の設定を保存させない（表示・保存可否・実行時解決を食い違わせない）。
 */
export function speechSyncedAfterRefresh(
  response: Pick<SpeechCatalogRefreshResponse, "catalogError">,
  current: ContentSettingsResponse | null,
): boolean {
  return current !== null || response.catalogError !== null;
}

/** 音声の保存を止める条件。同期できていない間は、表示が現在値と限らないため保存させない */
export function speechSaveDisabled(input: { busy: boolean; synced: boolean; dirty: boolean }): boolean {
  return input.busy || !input.synced || !input.dirty;
}

/** 選択中の選択肢を PUT の本文へ。provider を決められないときは null (保存させない) */
export function imageModelSelection(options: ImageModelOption[], value: string): UpdateContentImageBody | null {
  const option = options.find((entry) => entry.value === value);
  return option?.model ? { provider: option.model.provider, model: option.model.id } : null;
}

/** キー入力の後始末。保存できたときだけ空へ戻し、失敗時は再入力を避けて残す */
export function keyDraftAfterSave(draft: string, saved: boolean): string {
  return saved ? "" : draft;
}

/** 削除の確認。新しい会話で使えなくなることと、既存の会話で実行時に失敗することを先に伝える */
export function deleteContentKeyConfirmRequest(providerName: string): ConfirmRequest {
  return {
    kind: "confirm",
    title: "コンテンツ生成のAPIキーを削除",
    subject: { label: "対象の provider", value: providerName },
    body: [
      "generate_image と generate_speech は新しい会話で使えなくなり、既存の会話で実行するとキー無効エラーになります。",
    ],
    confirmLabel: "削除する",
    danger: true,
  };
}
