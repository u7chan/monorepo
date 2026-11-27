/**
 * 設定 → コンテンツ生成の音声タブの表示変換。モデルとボイスの選択肢・価格・話速の入力・[保存] の本文を、
 * DOM に依存しない純関数としてテストできるようにする。
 */
import type {
  ContentSettingsResponse,
  ContentSpeechSettings,
  ModelPrice,
  SpeechModel,
  UpdateContentSpeechBody,
} from "../../types";
import { messageTimeLabel, type MessageTimeOptions } from "../messageTime";
import { compareOptionLabels, contentProviderId, formatPriceAmount, optionLabel } from "./shared";

export const CONTENT_SPEECH_SAVED_NOTE = "音声生成のモデルとボイスを保存しました。";

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
    .map((entry) => {
      const label = optionLabel(entry, (nameCounts.get(entry.name) ?? 0) > 1);
      const price = speechPriceDisplay(entry.prices).primary;
      return {
        value: entry.id,
        label: price === null ? label : `${label}（${price.text}）`,
        model: entry,
      };
    })
    .sort((a, b) => compareOptionLabels(a.label, b.label));
  if (speech.model !== null && !options.some((option) => option.value === speech.model)) {
    options.unshift({
      value: speech.model,
      label: `${speech.model}（カタログ外）`,
      model: {
        provider: contentProviderId(provider),
        id: speech.model,
        name: "",
        prices: [],
        visible: true,
        note: null,
      },
    });
  }
  return options;
}

/**
 * 描画用の音声モデル選択肢。`speechModelOptions()` は全件のまま残し（PUT 本文の解決と試行が使う）、
 * ここだけが `visible: false` を落とす。保存中の値は専用ラベルで残す。
 */
export function visibleSpeechModelOptions(
  settings: Pick<ContentSettingsResponse, "provider" | "speech">,
): SpeechModelOption[] {
  const all = speechModelOptions(settings);
  const savedValue = speechModelValue(settings);
  const hidden = new Set(settings.speech.models.filter((entry) => !entry.visible).map((entry) => entry.id));
  const options = all.filter((option) => !hidden.has(option.value));
  const saved = all.find((option) => option.value === savedValue);
  if (saved !== undefined && hidden.has(savedValue)) {
    const entry = settings.speech.models.find((candidate) => candidate.id === savedValue);
    const name = entry?.name || saved.model?.id || savedValue;
    options.unshift({ ...saved, label: `${name}（一覧に出していません・保存済み）` });
  }
  return options;
}

/** 一覧に出していない件数。選択肢から黙って消えたように見せないために注記する */
export function hiddenSpeechModelCount(settings: Pick<ContentSettingsResponse, "speech">): number {
  return settings.speech.models.filter((entry) => !entry.visible).length;
}

/** 保存中のモデルが出どころから外れている理由。保存値は保持する（保存・試行の照合はサーバーが全件で行う） */
export function speechModelVisibilityNotice(
  settings: Pick<ContentSettingsResponse, "provider" | "speech">,
): { kind: "missing" | "hidden"; text: string } | null {
  const savedValue = speechModelValue(settings);
  if (savedValue === "") return null;
  const entry = settings.speech.models.find((candidate) => candidate.id === savedValue);
  if (entry === undefined) {
    return { kind: "missing", text: "保存中のモデルはカタログにありません（保存済みの値のまま使えます）。" };
  }
  if (!entry.visible) {
    return {
      kind: "hidden",
      text: "保存中のモデルはコストマスタで一覧に出さない設定です（保存済みのためこのまま使えます）。",
    };
  }
  return null;
}

/** 単価の入力 / 出力の見出し。チップと選択肢で同じ語を使う */
export function speechPriceSideLabel(side: ModelPrice["side"]): string {
  return side === "input" ? "入力" : "出力";
}

/** 音声の単価は入力側を主、出力側を副にする（Seed Audio のように出力だけのモデルもある） */
const SPEECH_PRICE_UNITS = {
  character: { suffix: "/M 文字", factor: 1_000_000, note: "文字数あたりの単価です（数え方は provider に従います）" },
  byte: { suffix: "/M bytes", factor: 1_000_000, note: "UTF-8 バイト数あたりの単価です" },
  token: { suffix: "/M tok", factor: 1_000_000, note: "token 建ての単価です（テキストと音声で数え方が異なります）" },
  minute: { suffix: "/分", factor: 1, note: "音声の長さ（分）あたりの単価です" },
  request: { suffix: "/回", factor: 1, note: null },
} as const;
const SPEECH_PRICE_UNIT_ORDER = ["character", "byte", "token", "minute", "request"] as const;

export interface SpeechPriceDisplay {
  /** 選択の指標にする側。入力があれば入力、無ければ出力 */
  primary: { side: ModelPrice["side"]; text: string } | null;
  secondary: { side: ModelPrice["side"]; text: string } | null;
  note: string | null;
}

/**
 * 音声の単価の表示。入力側を主にし、出力側があれば副として返す。**表示順はここ 1 箇所**で決める
 * （生成物の並びは変えない）。`prices` が空なら `--`、宣言された 0 は `$0`。
 */
export function speechPriceDisplay(prices: readonly ModelPrice[]): SpeechPriceDisplay {
  const usable = prices.filter((price) => price.unit in SPEECH_PRICE_UNITS);
  if (usable.length === 0) return { primary: null, secondary: null, note: null };
  const order = (price: ModelPrice): number =>
    SPEECH_PRICE_UNIT_ORDER.indexOf(price.unit as (typeof SPEECH_PRICE_UNIT_ORDER)[number]);
  const sorted = [...usable].sort((a, b) => (a.side === b.side ? order(a) - order(b) : a.side === "input" ? -1 : 1));
  const format = (price: ModelPrice): string => {
    const spec = SPEECH_PRICE_UNITS[price.unit as keyof typeof SPEECH_PRICE_UNITS];
    return `${formatPriceAmount(price.costUsd * spec.factor)}${spec.suffix}`;
  };
  const primary = sorted[0] as ModelPrice;
  const secondary = sorted.find((price) => price.side !== primary.side);
  const notes = [
    ...new Set(
      sorted
        .map((price) => SPEECH_PRICE_UNITS[price.unit as keyof typeof SPEECH_PRICE_UNITS].note)
        .filter((note) => note !== null),
    ),
  ];
  return {
    primary: { side: primary.side, text: format(primary) },
    secondary: secondary === undefined ? null : { side: secondary.side, text: format(secondary) },
    note: notes.length === 0 ? null : notes.join(" "),
  };
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

/** 音声タブの画面の選択（保存される設定）と、試行・証拠が使う値。1 箇所で決めて面と試行で食い違わせない */
export interface SpeechScreenSelection {
  options: SpeechModelOption[];
  savedModel: string;
  savedVoice: string;
  selectedModel: string;
  selectedOption: SpeechModelOption | undefined;
  selectedVoice: string;
  /** ボイス欄の形。宣言があるモデルは選択、無いモデルは自由記述 */
  textMode: boolean;
  /** 保存値と違うか（保存ボタンの活性） */
  dirty: boolean;
}

/** 音声タブの表示と試行のモデル / ボイスを決める。試行は未設定でも履歴を出すため、この解決だけを先に使う */
export function speechScreenSelection(
  settings: Pick<ContentSettingsResponse, "provider" | "speech">,
  draft: { model: string | null; voice: string | null },
): SpeechScreenSelection {
  const options = speechModelOptions(settings);
  const savedModel = speechModelValue(settings);
  const savedVoice = settings.speech.voice;
  const selectedModel = draft.model ?? savedModel;
  const selectedOption = options.find((option) => option.value === selectedModel);
  // モデルを切り替えたら、ボイスは新しいモデルの既定（先頭、宣言が無ければ空）へ寄せる
  const selectedVoice = speechVoiceDraft({
    draft: draft.voice,
    modelChanged: draft.model !== null,
    option: selectedOption,
    savedVoice,
  });
  return {
    options,
    savedModel,
    savedVoice,
    selectedModel,
    selectedOption,
    selectedVoice,
    textMode: speechVoiceMode(selectedOption) === "text",
    dirty: selectedModel !== savedModel || selectedVoice !== savedVoice,
  };
}

/** 音声の保存を止める条件。保存中と、変更が無いときだけ止める */
export function speechSaveDisabled(input: { busy: boolean; dirty: boolean }): boolean {
  return input.busy || !input.dirty;
}

export const SPEECH_SPEED_ERROR = "速度は正の数で入力してください（空欄は provider の既定）";

/** 速度入力の解釈。空欄は「指定なし」（provider の既定）で、それ以外は正の有限数だけを受け付ける。 */
export function speechSpeed(raw: string): { ok: true; speed?: number } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true };
  const speed = Number(trimmed);
  if (!Number.isFinite(speed) || speed <= 0) return { ok: false, error: SPEECH_SPEED_ERROR };
  return { ok: true, speed };
}

/** 速度欄の増減幅。押下 1 回で 0.1 動かす */
export const SPEECH_SPEED_STEP = 0.1;

/** 増減の下限。0 以下は送れない値なので、押下だけで不正値を作らない（上限は provider の 400 に委ねる） */
export const SPEECH_SPEED_MIN = 0.1;

/** 欄の値を扱う 1/100 単位。丸めを十進の桁で行うため、小数のまま足さない */
const SPEED_SCALE = 100;

/** 押下の起点。空欄と解釈できない値は 1.0（標準）から始める（押しても何も起きないボタンを作らない） */
const SPEED_STANDARD = SPEED_SCALE;

const SPEED_FLOOR = Math.round(SPEECH_SPEED_MIN * SPEED_SCALE);

/** 十進で書かれた小数。指数表記になる極端な値は数値のまま扱う */
const SPEED_DECIMAL = /^(\d+)(?:\.(\d*))?$/;

/**
 * 入力の 1/100 単位。解釈できない / 0 以下と、1/100 単位で表せない大きさは null (起点を 1.0 へ寄せる)。
 * 丸めは数値に直してから十進の桁で行う (表記で結果が変わらず、二進の誤差で 1 桁ずれない)。
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
 * 起点は空欄と解釈できない値で 1.0、下限は `SPEECH_SPEED_MIN` で止める。
 */
export function speechSpeedStep(raw: string, delta: number): string {
  const current = speedUnits(raw.trim()) ?? SPEED_STANDARD;
  return String(Math.max(SPEED_FLOOR, current + Math.round(delta * SPEED_SCALE)) / SPEED_SCALE);
}
