/**
 * 設定 → コンテンツ生成の表示変換。DOM に依存しない純関数だけを置き、
 * 選択肢の組み立て・入力の後始末・保存後の文言・確認文をテストできるようにする。
 */
import type {
  ContentImageSettings,
  ContentSettingsResponse,
  ContentSpeechSettings,
  ModelRef,
  SpeechCatalogRefreshResponse,
  SpeechModel,
  SpeechPreviewBody,
  UpdateContentImageBody,
  UpdateContentSpeechBody,
} from "../types";
import type { ConfirmRequest } from "./confirmDialog";
import { messageTimeLabel, type MessageTimeOptions } from "./messageTime";
import { modelRefKey, type ProviderBadge } from "./modelSettings";
import { messageFor } from "./settingsResource";

/** コンテンツ生成の初期注記。キーの有無に関わらず出す */
export const CONTENT_SETTINGS_NOTE = "コンテンツ生成の設定はサーバーに保存され、再起動後も残ります。";

export const CONTENT_KEY_SAVED_NOTE =
  "コンテンツ生成のAPIキーを保存しました。新しい会話から generate_image・generate_speech・generate_bgm を使えます。";
export const CONTENT_KEY_DELETED_NOTE =
  "コンテンツ生成のAPIキーを削除しました。generate_image・generate_speech・generate_bgm は新しい会話から使えません。";
export const CONTENT_MODEL_SAVED_NOTE = "画像生成のモデルを保存しました。";
export const CONTENT_SPEECH_SAVED_NOTE = "音声生成のモデルとボイスを保存しました。";

/** 音声カタログ更新後に現在値を確認できなかったときの注記。確認できるまで音声の設定を保存させない */
export const SPEECH_SYNC_FAILED_NOTE =
  "音声モデル一覧は取得しましたが、現在の設定を確認できませんでした。再読み込みするまで音声の設定は保存できません。";

/** 実行中の操作。null なら操作なし */
export type ContentSavingAction = "enabled" | "key" | "delete" | "selection" | "catalog" | "speech" | "speech-catalog";

/**
 * 有効 / 無効を保存したときの注記。ツール一覧はセッション作成時に固定するため、OFF は既存の会話に
 * 効くが、ON は OFF の間に作った会話には効かない（そこにはツールが無い）ことを書き分ける。
 */
export function contentEnabledNote(enabled: boolean): string {
  return enabled
    ? "コンテンツ生成を有効にしました。ツールを持つ既存の会話では次の呼び出しから generate_image・generate_speech・generate_bgm を使えます（OFF の間に作った会話にはツールが無いため、新しい会話で使えます）。"
    : "コンテンツ生成を無効にしました。既存の会話でも次の呼び出しから固定の文言で失敗します（キーと選択は残ります）。";
}

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
 * モデル選択の選択肢。表示名の昇順（`localeCompare` を使わない単純な文字列比較）に並べ、保存済みの
 * モデルがカタログに無ければ現在の id を「（カタログ外）」として先頭に足す (何が保存されているかを見失わせない)。
 * name は DTO 上は空を許すため、表示名に使えないときと、同じ name が複数あるときは id を添えて一意にする。
 */
export function imageModelOptions(settings: Pick<ContentSettingsResponse, "provider" | "image">): ImageModelOption[] {
  const { provider, image } = settings;
  const nameCounts = new Map<string, number>();
  for (const entry of image.models) {
    if (entry.name === "") continue;
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }
  const options: ImageModelOption[] = image.models
    .map((entry) => ({
      value: modelRefKey({ provider: entry.provider, id: entry.id }),
      label: optionLabel(entry, (nameCounts.get(entry.name) ?? 0) > 1),
      model: { provider: entry.provider, id: entry.id },
    }))
    .sort((a, b) => compareOptionLabels(a.label, b.label));
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

/** 表示名の昇順。`localeCompare` はロケール依存を持ち込むため使わず、ASCII の単純比較にする */
function compareOptionLabels(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
 * 音声モデルの選択肢。画像と同じ比較器で表示名の昇順に並べ、保存済みのモデルがカタログに無ければ
 * 現在の id を「（カタログ外）」として先頭に足す。
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
  const options: SpeechModelOption[] = speech.models
    .map((entry) => ({
      value: entry.id,
      label: optionLabel(entry, (nameCounts.get(entry.name) ?? 0) > 1),
      model: entry,
    }))
    .sort((a, b) => compareOptionLabels(a.label, b.label));
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
 * 再取得後に server の実効値を確認できたか。成功した GET だけが「確認できた」の根拠で、一覧が変わったのに
 * 現在値を取れないときは false にする。既に同期済みなら、一覧が変わらない再取得の失敗（`catalogError`）は
 * 以前の値を現在値のまま保つが、未同期の状態は成功した GET が取れるまで false のままにする。
 */
export function speechSyncedAfterRefresh(
  previousSynced: boolean,
  response: Pick<SpeechCatalogRefreshResponse, "catalogError">,
  current: ContentSettingsResponse | null,
): boolean {
  if (current !== null) return true;
  return previousSynced && response.catalogError !== null;
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
      "generate_image・generate_speech・generate_bgm は新しい会話で使えなくなり、既存の会話で実行するとキー無効エラーになります。",
    ],
    confirmLabel: "削除する",
    danger: true,
  };
}

/** お試し再生で受け取る形式。BFF は mp3 を `audio/mpeg`、pcm は RIFF 化して `audio/wav` で返す */
export type SpeechPreviewFormat = "mp3" | "wav";

/** お試し再生の結果。`format` は応答の Content-Type から読む（判別できない応答は undefined） */
export interface SpeechPreviewAudio {
  blob: Blob;
  format: SpeechPreviewFormat | undefined;
}

/** お試し再生の入力。速度は入力欄の文字列のまま持ち、送信時に解釈する */
export interface SpeechPreviewDraft {
  model: string;
  voice: string;
  text: string;
  instructions: string;
  speed: string;
}

export const SPEECH_PREVIEW_NO_MODEL_ERROR = "音声モデルを選択してください";
export const SPEECH_PREVIEW_EMPTY_TEXT_ERROR = "読み上げる文章を入力してください";
export const SPEECH_PREVIEW_SPEED_ERROR = "速度は正の数で入力してください（空欄は provider の既定）";
export const SPEECH_PREVIEW_UNKNOWN_FAILURE_NOTE = "音声を生成できませんでした";

/** お試し再生の初期値。保存済みのモデルと声から始める（この画面の選択は保存値へ書き戻さない） */
export function speechPreviewInitialDraft(settings: Pick<ContentSettingsResponse, "speech">): SpeechPreviewDraft {
  return { model: speechModelValue(settings), voice: settings.speech.voice, text: "", instructions: "", speed: "" };
}

/** 名前が取れないときの本文。空の名前を差し込むと発話の意味が変わってしまうため、名前無しの文へ落とす */
const SPEECH_PREVIEW_NO_NAME_TEXT = "こんにちは！よろしくお願いします。";

/**
 * お試し再生の本文の初期値（テンプレ）。名前は provider の接頭辞を落とすだけで、読みは TTS に任せる
 * （読みの表は provider が増えるたびに埋まらない穴が残るため持たない。不自然なら本文を直せばよい）。
 */
export function speechPreviewDefaultText(model: SpeechModel | null | undefined): string {
  const name = model == null ? "" : speechPreviewModelName(model);
  return name === "" ? SPEECH_PREVIEW_NO_NAME_TEXT : `こんにちは、${name}です！よろしくお願いします。`;
}

/** テンプレへ入れる名前。接頭辞 (`Google: `) を落とし、落として空になる名前はそのまま使う */
function speechPreviewModelName(model: SpeechModel): string {
  const separator = model.name.indexOf(": ");
  const withoutPrefix = separator === -1 ? "" : model.name.slice(separator + 2);
  if (withoutPrefix !== "") return withoutPrefix;
  return model.name === "" ? model.id : model.name;
}

/**
 * 速度入力の解釈。空欄は「指定なし」（provider の既定）で、それ以外は正の有限数だけを受け付ける。
 * 対応モデルの範囲（0.5–2.0 など）は provider の制約なので、ここでは縛らない。
 */
export function speechPreviewSpeed(raw: string): { ok: true; speed?: number } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true };
  const speed = Number(trimmed);
  if (!Number.isFinite(speed) || speed <= 0) return { ok: false, error: SPEECH_PREVIEW_SPEED_ERROR };
  return { ok: true, speed };
}

/** 速度欄の増減幅。押下 1 回で 0.1 動かす */
export const SPEECH_PREVIEW_SPEED_STEP = 0.1;

/** 増減の下限。0 以下は送れない値なので、押下だけで不正値を作らない（上限は provider の 400 に委ねる） */
export const SPEECH_PREVIEW_SPEED_MIN = 0.1;

/** 欄の値を扱う 1/100 単位。丸めを十進の桁で行うため、小数のまま足さない */
const SPEED_SCALE = 100;

/** 押下の起点。空欄と解釈できない値は 1.0（標準）から始める（押しても何も起きないボタンを作らない） */
const SPEED_STANDARD = SPEED_SCALE;

const SPEED_FLOOR = Math.round(SPEECH_PREVIEW_SPEED_MIN * SPEED_SCALE);

/** 十進で書かれた小数。指数表記になる極端な値は数値のまま扱う */
const SPEED_DECIMAL = /^(\d+)(?:\.(\d*))?$/;

/**
 * 入力の 1/100 単位。解釈できない / 0 以下の値と、1/100 単位で表せない大きさの値は null
 * （＝起点を 1.0 へ寄せる）。
 * 丸めは数値に直してから十進の桁で行う。表記（`+0.565` / `.565` / `5.65e-1`）で結果が変わらず、
 * `1.015 - 0.1` の丸めも二進の誤差で 1 桁ずれない。丸めで 0 単位になる正の値（0.004）は、
 * 0 や未指定と区別して下限へ寄せる。
 */
function speedUnits(raw: string): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  const decimal = SPEED_DECIMAL.exec(String(value));
  if (decimal === null) {
    const scaled = value * SPEED_SCALE;
    return Number.isFinite(scaled) ? Math.round(scaled) : null;
  }
  const [, whole = "", fraction = ""] = decimal;
  const units = Number(`${whole}${fraction.slice(0, 2).padEnd(2, "0")}`) + (Number(fraction[2] ?? 0) >= 5 ? 1 : 0);
  return Number.isFinite(units) ? units : null;
}

/**
 * 速度欄の増減。押下 1 回で `delta` だけ動かし、欄の値として小数 2 桁で返す。
 * 起点は空欄と解釈できない値で 1.0、下限は `SPEECH_PREVIEW_SPEED_MIN` で止める。
 */
export function speechPreviewSpeedStep(raw: string, delta: number): string {
  const current = speedUnits(raw.trim()) ?? SPEED_STANDARD;
  return String(Math.max(SPEED_FLOOR, current + Math.round(delta * SPEED_SCALE)) / SPEED_SCALE);
}

/** 送信前の検証。止められるものは API を呼ばず、クレジットも消費させない */
export function speechPreviewRequest(
  draft: SpeechPreviewDraft,
): { ok: true; body: SpeechPreviewBody } | { ok: false; error: string } {
  if (draft.model === "") return { ok: false, error: SPEECH_PREVIEW_NO_MODEL_ERROR };
  if (draft.text.trim() === "") return { ok: false, error: SPEECH_PREVIEW_EMPTY_TEXT_ERROR };
  const speed = speechPreviewSpeed(draft.speed);
  if (!speed.ok) return speed;
  return {
    ok: true,
    body: {
      model: draft.model,
      voice: draft.voice,
      text: draft.text,
      instructions: draft.instructions,
      ...(speed.speed === undefined ? {} : { speed: speed.speed }),
    },
  };
}

/** お試し再生の主ボタン。`replayable` のときだけ鳴らす意味になり、それ以外は生成へ戻る */
export interface SpeechPreviewPrimaryAction {
  replayable: boolean;
  label: string;
}

/**
 * 主ボタンの意味。いまの入力の署名 (`body`) が最後に生成した要求 (`lastBody`) と一致するときだけ再生にする。
 * 比較を本文の JSON で行うのは `speechPreviewRequest` の組み立て順が固定で、同じ入力なら同じ文字列になるため。
 */
export function speechPreviewPrimaryAction(input: {
  busy: boolean;
  body: SpeechPreviewBody | null;
  lastBody: SpeechPreviewBody | null;
}): SpeechPreviewPrimaryAction {
  if (input.busy) return { replayable: false, label: "生成中…" };
  const replayable =
    input.body !== null && input.lastBody !== null && JSON.stringify(input.body) === JSON.stringify(input.lastBody);
  return replayable ? { replayable: true, label: "もう一度再生" } : { replayable: false, label: "音声を生成" };
}

/** 応答の Content-Type から表示形式を決める。判別できない応答は形式を推測せず undefined にする */
export function speechPreviewFormatOf(contentType: string | null): SpeechPreviewFormat | undefined {
  const mediaType = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
  if (mediaType === "audio/mpeg") return "mp3";
  if (mediaType === "audio/wav") return "wav";
  return undefined;
}

/** どちらの形式で返ったかを画面に出す。判別できなかったときは形式の表示だけを省く */
export function speechPreviewFormatNote(format: SpeechPreviewFormat | undefined): string {
  return format === undefined ? "音声を生成しました" : `音声を生成しました（${format}）`;
}

/** 失敗の表示文言。分類済みの文言はサーバーが `{ error }` で返すため、そのまま画面へ出す */
export function speechPreviewFailureNote(error: unknown): string {
  const message = messageFor(error);
  return /^HTTP \d+$/.test(message) ? `${SPEECH_PREVIEW_UNKNOWN_FAILURE_NOTE}（${message}）` : message;
}
