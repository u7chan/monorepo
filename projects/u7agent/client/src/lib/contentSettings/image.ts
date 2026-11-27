/**
 * 設定 → コンテンツ生成の画像タブの表示変換。生成元の選択肢・モデルの選択肢と並び順・価格・既定の入力・
 * [保存] の本文を、DOM に依存しない純関数としてテストできるようにする。
 */
import type {
  ContentImageAuth,
  ContentImageSettings,
  ContentSettingsResponse,
  ImageGenerationProvider,
  ImageModelPrice,
  ImageParameterValues,
  ModelPrice,
  ModelRef,
  UpdateContentImageBody,
} from "../../types";
import { imageModelParameterDeclarations, imageParameterDraftOf, imageParameterFields } from "../imageParameters";
import type { ImageParameterDraft, ImageParameterField } from "../imageParameters";
import { messageTimeLabel, type MessageTimeOptions } from "../messageTime";
import { modelRefKey, type ProviderBadge } from "../modelSettings";
import { compareOptionLabels, formatPriceAmount, optionLabel } from "./shared";

/** 画像の [保存] の成功注記。`onSaveSelection` はモデルと既定のパラメータ（値あり / 省略）を送るため、両方を書く */
export const CONTENT_IMAGE_SAVED_NOTE = "画像生成のモデルと既定を保存しました。";

/** 画像の生成元の選択肢。radio の並び・表示名・案内をここ 1 箇所で作る */
export interface ImageProviderOption {
  value: ImageGenerationProvider;
  label: string;
  description: string;
}

export const IMAGE_PROVIDER_OPTIONS: readonly ImageProviderOption[] = [
  {
    value: "openrouter",
    label: "OpenRouter",
    description: "APIキーと画像モデルを指定します。音声 / BGM もこのAPIキーを使います。",
  },
  {
    value: "codex",
    label: "Codex",
    description:
      "OpenAI Codex のサインイン（openai-codex）で生成します。設定 → モデル（/settings/models）の「OpenAI Codex」からサインインします。同じ画面の「Sign in with ChatGPT」は別の資格情報（openai）で、Codex の画像生成には使われません。画像モデルはバックエンドが選び（不明と表示）、参照画像の編集はできません。利用枠は ChatGPT の画像生成枠です。",
  },
];

/** 生成元の表示名。見出し・削除の確認文などで使う */
export function contentImageProviderLabel(provider: ImageGenerationProvider): string {
  return IMAGE_PROVIDER_OPTIONS.find((option) => option.value === provider)?.label ?? provider;
}

/**
 * 生成元の切り替えの注記。既存の会話にも次の呼び出しから効くことと、未設定からの有効化だけは
 * 新しい会話が要ることを書き分ける（ツール一覧をセッション作成時に固定するため）。
 */
export function contentImageProviderNote(provider: ImageGenerationProvider): string {
  return `画像の生成元を ${contentImageProviderLabel(provider)} に変更しました。他方の設定は残ります。ツールを持つ既存の会話でも、次の呼び出しから新しい生成元を使います（未設定から有効にしたときだけ、ツールが無い会話には新しい会話が必要です）。`;
}

/** 認証状態のバッジ。保存済みでも使えない値を「設定済み」と誤表示しない */
export function imageAuthBadge(auth: ContentImageAuth): ProviderBadge {
  if (auth.state === "configured") return { label: "認証済み", tone: "ok" };
  if (auth.state === "expired") return { label: "認証の期限切れ", tone: "warn" };
  return { label: "未認証", tone: "muted" };
}

/**
 * Codex のサインイン案内。APIキーを前提にせず登録先を名指しする (`openai` の資格情報とは別)。
 * 同じ画面の「OpenAI Codex」行からサインインでき、`openai` の行とは併用できる。
 */
export const CODEX_SIGN_IN_NOTICE =
  "Codex のサインイン（openai-codex）が見つかりません。設定 → モデル（/settings/models）の「OpenAI Codex」からサインインしてください。APIキーは不要です。同じ画面の「Sign in with ChatGPT」は別の資格情報（openai）で、Codex の画像生成には使われません。";
export const CODEX_SIGN_IN_EXPIRED_NOTICE =
  "Codex のサインイン（openai-codex）の期限が切れています。生成を実行するとサインインの更新を試みます。更新に失敗するときは、設定 → モデル（/settings/models）の「OpenAI Codex」からサインインし直してください。";
export const OPENROUTER_IMAGE_KEY_NOTICE =
  "OpenRouter のAPIキーが未設定です。下の欄で登録すると generate_image を使えます。";
/** 暗号文はあるが復号できない / 未評価のキー。「未設定」と書くと保存済みの値を捨てる案内になる */
export const OPENROUTER_IMAGE_KEY_UNUSABLE_NOTICE =
  "保存済みの OpenRouter のAPIキーを使えません。下の欄で登録し直すと generate_image を使えます。";

/**
 * 認証が足りないときの案内 (使えるときは null)。`image.auth` は値を持たないため、OpenRouter の
 * 「保存済みだが使えない」はキーの状態で書き分ける。
 */
export function imageAuthNotice(
  settings: Pick<ContentSettingsResponse, "keyStored" | "keyAvailable" | "keyErrorMessage" | "image">,
): string | null {
  const { auth, provider } = settings.image;
  if (provider === "codex") {
    if (auth.state === "configured") return null;
    return auth.state === "expired" ? CODEX_SIGN_IN_EXPIRED_NOTICE : CODEX_SIGN_IN_NOTICE;
  }
  if (auth.state === "configured") return null;
  const unusable = settings.keyStored && !settings.keyAvailable;
  if (!unusable) return OPENROUTER_IMAGE_KEY_NOTICE;
  return settings.keyErrorMessage ?? OPENROUTER_IMAGE_KEY_UNUSABLE_NOTICE;
}

/** Codex は画像モデルを選ばないため、モデル一覧と保存フォームを出さない */
export function imageModelSectionVisible(provider: ImageGenerationProvider): boolean {
  return provider === "openrouter";
}

/** 音声 / BGM が OpenRouter のAPIキーを必要とする旨。Codex を選んでも音声は使えないことを明示する */
export const SPEECH_NEEDS_OPENROUTER_KEY_NOTE =
  "音声 / BGM は OpenRouter のAPIキーで生成します。画像の生成元に Codex を選んでいても、音声 / BGM を使うには OpenRouter のAPIキーが必要です。";

/** 画像タブの生成元欄の見出し */
export const CONTENT_IMAGE_PROVIDER_HEADING = "画像の生成元";

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

/** 価格 1 件の単位ごとの表記。token は 1M token あたりへ換算する（1 枚の実額ではない） */
const IMAGE_PRICE_UNITS = {
  image: { suffix: "/枚", factor: 1 },
  megapixel: { suffix: "/MP", factor: 1 },
  token: { suffix: "/1M tok", factor: 1_000_000 },
  request: { suffix: "/回", factor: 1 },
} as const;
const IMAGE_PRICE_UNIT_ORDER = ["image", "megapixel", "token", "request"] as const;
const IMAGE_PRICE_TOKEN_NOTE = "token 建ての単価です（1 枚あたりの実額ではありません）";

/**
 * 価格の表示。**基本単価（`variant: ""`）を優先**し、無いモデルだけ同じ unit の中で範囲を出す
 * （加算オプションを基本単価の範囲に混ぜない）。unit が複数あるときは image → megapixel → token → request の順。
 */
export function imagePriceDisplay(prices: readonly ModelPrice[]): { label: string; note: string | null } {
  const unit = IMAGE_PRICE_UNIT_ORDER.find((candidate) => prices.some((price) => price.unit === candidate));
  if (unit === undefined) return { label: "--", note: null };
  const rows = prices.filter((price) => price.unit === unit);
  const spec = IMAGE_PRICE_UNITS[unit];
  const format = (costUsd: number): string => `${formatPriceAmount(costUsd * spec.factor)}${spec.suffix}`;
  const basic = rows.find((price) => price.variant === "");
  let label: string;
  if (basic !== undefined) {
    label = format(basic.costUsd);
  } else {
    const amounts = rows.map((price) => price.costUsd * spec.factor);
    const min = Math.min(...amounts);
    const max = Math.max(...amounts);
    label =
      min === max
        ? `${formatPriceAmount(min)}${spec.suffix}`
        : `${formatPriceAmount(min)}〜${formatPriceAmount(max)}${spec.suffix}`;
  }
  return { label, note: unit === "token" ? IMAGE_PRICE_TOKEN_NOTE : null };
}

export interface ImageModelOption {
  /** 選択欄の値。`provider/id` 表記 */
  value: string;
  /** 表示名（ベンダー名を含む）。価格は `price` が持つ */
  label: string;
  /** 見出しに使うベンダー名。表示名が「ベンダー: モデル名」でないときは空文字 */
  vendor: string;
  /** ベンダー名を除いた行の表示名。見出しの下では同じ語を繰り返さない */
  name: string;
  /** 価格の表記。不明は `--` */
  price: string;
  /** 価格順の比較キー。単位が違う単価は比べられないため、単位から見る */
  priceKey: { unit: number; amount: number };
  /** PUT の本文を作るための参照。provider を決められない保存値では null */
  model: ModelRef | null;
}

/**
 * モデル選択の選択肢。単純な文字列比較の表示名順に並べ、保存済みがカタログに無ければ「（カタログ外）」
 * として先頭に足す。表示名が無い / 重複するときは id を添えて一意にする。
 */
export function imageModelOptions(settings: Pick<ContentSettingsResponse, "provider" | "image">): ImageModelOption[] {
  const { provider, image } = settings;
  const nameCounts = new Map<string, number>();
  for (const entry of image.models) {
    if (entry.name === "") continue;
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }
  const options: ImageModelOption[] = image.models
    .map((entry) =>
      imageModelOption({
        value: modelRefKey({ provider: entry.provider, id: entry.id }),
        label: optionLabel(entry, (nameCounts.get(entry.name) ?? 0) > 1),
        prices: entry.prices,
        model: { provider: entry.provider, id: entry.id },
      }),
    )
    .sort((a, b) => compareOptionLabels(a.label, b.label));
  if (provider !== null && image.model !== null && !options.some((option) => option.model?.id === image.model)) {
    const model = { provider, id: image.model };
    options.unshift(
      imageModelOption({ value: modelRefKey(model), label: `${image.model}（カタログ外）`, prices: [], model }),
    );
  }
  return options;
}

/**
 * 表示名を「ベンダー: モデル名」で割る。上流の表示名はベンダーを前置きするが、区切りが無い
 * （自分で付けた名前・id だけの名前）ときは見出しを作らず、行にそのまま出す。
 */
export function imageModelNameParts(label: string): { vendor: string; name: string } {
  const index = label.indexOf(": ");
  if (index <= 0) return { vendor: "", name: label };
  const vendor = label.slice(0, index).trim();
  const name = label.slice(index + 2).trim();
  return vendor === "" || name === "" ? { vendor: "", name: label } : { vendor, name };
}

/** 選択肢 1 件。価格は表示用の文字列と並び替え用のキーを別に持ち、行とトリガーで使い分ける */
function imageModelOption(input: {
  value: string;
  label: string;
  prices: readonly ImageModelPrice[];
  model: ModelRef | null;
}): ImageModelOption {
  return {
    value: input.value,
    label: input.label,
    ...imageModelNameParts(input.label),
    price: imagePriceDisplay(input.prices).label,
    priceKey: imagePriceSortKey(input.prices),
    model: input.model,
  };
}

/**
 * 価格順の比較キー。**単位が違う単価は同じ金額として比べられない**（1 枚と 1M token は桁も意味も違う）ため、
 * 単位の順を先に見る。価格が読めないモデルは末尾へ回す。
 */
export function imagePriceSortKey(prices: readonly ImageModelPrice[]): { unit: number; amount: number } {
  for (const [index, unit] of IMAGE_PRICE_UNIT_ORDER.entries()) {
    const rows = prices.filter((price) => price.unit === unit && Number.isFinite(price.costUsd) && price.costUsd >= 0);
    if (rows.length === 0) continue;
    const factor = IMAGE_PRICE_UNITS[unit].factor;
    const basic = rows.find((price) => price.variant === "");
    const amount =
      basic !== undefined ? basic.costUsd * factor : Math.min(...rows.map((price) => price.costUsd * factor));
    return { unit: index, amount };
  }
  return { unit: IMAGE_PRICE_UNIT_ORDER.length, amount: Number.POSITIVE_INFINITY };
}

/** 価格順の見出し。単位が変わると数字の意味も変わるので、同じ一覧に混ぜない */
const IMAGE_PRICE_UNIT_LABELS: Record<(typeof IMAGE_PRICE_UNIT_ORDER)[number], string> = {
  image: "1 枚あたり",
  megapixel: "1 MP あたり",
  token: "1M token あたり",
  request: "1 回あたり",
};
const IMAGE_PRICE_UNKNOWN_GROUP = "価格不明";

/** 価格順の見出し。`unit` は `IMAGE_PRICE_UNIT_ORDER` の位置で、末尾は価格が読めない行を指す */
function imagePriceGroupLabel(unit: number): string {
  const key = IMAGE_PRICE_UNIT_ORDER[unit];
  return key === undefined ? IMAGE_PRICE_UNKNOWN_GROUP : IMAGE_PRICE_UNIT_LABELS[key];
}

/** 画像モデルの並び順。見出しの軸も切り替える（ベンダー / 価格の単位） */
export type ImageModelSort = "vendor" | "price";

/** 選択欄の 1 行。見出しは連続する同じ値ごとに 1 つだけ描く */
export interface ImageModelPickerRow {
  value: string;
  /** 行の主表示 */
  label: string;
  /** トリガーの表示名。行で省いたベンダー名を戻す */
  fullLabel: string;
  /** 行の右端に出す価格。不明は `--` */
  price: string;
  /** 見出し。空文字なら見出し無し */
  group: string;
}

/**
 * 画像モデルの選択肢を並べ替える。ベンダー順は見出しをベンダーにし、価格順は見出しを単価の単位にする
 * （価格の比較は単位の中でだけ意味を持つ）。名前が同じときは表示名で決める（並びを入力順に依存させない）。
 */
export function imageModelPickerRows(
  options: readonly ImageModelOption[],
  sort: ImageModelSort,
): ImageModelPickerRow[] {
  if (sort === "price") {
    return [...options]
      .sort(
        (a, b) =>
          a.priceKey.unit - b.priceKey.unit ||
          a.priceKey.amount - b.priceKey.amount ||
          compareOptionLabels(a.label, b.label),
      )
      .map((option) => ({
        value: option.value,
        label: option.label,
        fullLabel: option.label,
        price: option.price,
        group: imagePriceGroupLabel(option.priceKey.unit),
      }));
  }
  return [...options]
    .sort((a, b) => compareOptionLabels(a.vendor, b.vendor) || compareOptionLabels(a.label, b.label))
    .map((option) => ({
      value: option.value,
      label: option.name,
      fullLabel: option.label,
      price: option.price,
      group: option.vendor,
    }));
}

/**
 * 描画用のモデル選択肢。`imageModelOptions()` は全件のまま残し (PUT 本文と既定の解決が使う)、
 * ここだけが `visible: false` を落とす。保存中の値が無効でも選択欄を空にしない。
 */
export function visibleImageModelOptions(
  settings: Pick<ContentSettingsResponse, "provider" | "image">,
): ImageModelOption[] {
  const all = imageModelOptions(settings);
  const savedValue = imageModelValue(settings);
  const hidden = new Set(
    settings.image.models
      .filter((entry) => !entry.visible)
      .map((entry) => modelRefKey({ provider: entry.provider, id: entry.id })),
  );
  const options = all.filter((option) => !hidden.has(option.value));
  const saved = all.find((option) => option.value === savedValue);
  if (saved !== undefined && hidden.has(savedValue)) {
    const entry = settings.image.models.find(
      (candidate) => modelRefKey({ provider: candidate.provider, id: candidate.id }) === savedValue,
    );
    const name = entry?.name || saved.model?.id || savedValue;
    options.unshift(
      imageModelOption({
        value: saved.value,
        label: `${name}（一覧に出していません・保存済み）`,
        prices: entry?.prices ?? [],
        model: saved.model,
      }),
    );
  }
  return options;
}

/** 一覧に出していない件数。選択肢から黙って消えたように見せないために注記する */
export function hiddenImageModelCount(settings: Pick<ContentSettingsResponse, "image">): number {
  return settings.image.models.filter((entry) => !entry.visible).length;
}

/**
 * 保存中の値が選択肢の既定から外れている理由。**カタログに無い**と**マスタで無効**を別の文言にし、
 * どちらも保存値は保持する（保存・試行の照合はサーバーが現在の一覧をそのまま使う）。
 */
export function imageModelVisibilityNotice(
  settings: Pick<ContentSettingsResponse, "provider" | "image">,
): { kind: "missing" | "hidden"; text: string } | null {
  const savedValue = imageModelValue(settings);
  if (savedValue === "") return null;
  const entry = settings.image.models.find(
    (candidate) => modelRefKey({ provider: candidate.provider, id: candidate.id }) === savedValue,
  );
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

/**
 * 画面に出ている画像モデル (`provider/id`)。下書きがあれば下書き、無ければ保存値で、試行の開始と
 * 証拠の判定もこの 1 つを使う (保存前の試行や別モデルの実績を混ぜない)。
 */
export function imageScreenModel(input: { draft: string | null; savedModel: string }): string {
  return input.draft ?? input.savedModel;
}

/** 選択欄の現在値。行が無い (未設定) か provider を決められないときは空文字 */
export function imageModelValue(settings: Pick<ContentSettingsResponse, "provider" | "image">): string {
  if (settings.provider === null || settings.image.model === null) return "";
  return modelRefKey({ provider: settings.provider, id: settings.image.model });
}

/** 選択中の選択肢を PUT の本文へ。provider を決められないときは null (保存させない) */
export function imageModelSelection(
  options: readonly ImageModelOption[],
  value: string,
): UpdateContentImageBody | null {
  const option = options.find((entry) => entry.value === value);
  return option?.model ? { provider: option.model.provider, model: option.model.id } : null;
}

/** 既定の入力の未指定ラベル。保存値を持たないことは provider の既定への委譲として書く */
export const IMAGE_DEFAULT_NONE_LABEL = "既定なし（provider 既定）";

/** 既定の入力欄の注記。保存した既定がいつ使われるかと、試行の入力と別であることを伝える */
export const IMAGE_DEFAULT_NOTE =
  "保存した既定は generate_image の引数を省略したときに使います。空欄は既定なし（provider 既定）で、試行の入力とは別に保存します。";

/** 画面のモデル（`provider/id`）に対応する既定の保存キー（bare なモデル id）。選択肢に無ければ null */
export function imageDefaultModelId(options: readonly ImageModelOption[], model: string): string | null {
  return options.find((option) => option.value === model)?.model?.id ?? null;
}

/** 既定の入力の下書き。編集したモデルと組にし、別のモデルへ値を持ち越さない */
export interface ImageDefaultsDraft {
  model: string;
  values: ImageParameterDraft;
}

/** 保存値を入力欄の値として比べるための文字列。未指定は空欄 */
function defaultDraftValue(value: string | number | undefined): string {
  return value === undefined ? "" : String(value);
}

/**
 * 既定の入力が保存値と違うか。欄に無いキーは画面から変えられないため比べない（宣言が変わっても
 * 保存できない差分を作らない）。モデルだけを見ていた判定にパラメータを足す。
 */
export function imageDefaultDirty(
  fields: readonly ImageParameterField[],
  draft: ImageParameterDraft,
  saved: ImageParameterValues,
): boolean {
  return fields.some((field) => (draft[field.name] ?? "").trim() !== defaultDraftValue(saved[field.name]));
}

/** 既定として送る値と、保存値から変わっていないか */
export interface ImageDefaultBody {
  /** そのモデルの全項目（入力欄に載る宣言の値だけ。未指定は持たない） */
  parameters: ImageParameterValues;
  /** 保存値と同じ。同じなら [保存] は `parameters` を省略する */
  unchanged: boolean;
}

/**
 * [保存] で送る `parameters`。PUT は部分更新ではないため、編集が 1 つでもあれば宣言にある全項目を
 * 返し、無ければ `unchanged` にする (`{}` を作らないのは切替先の既定を消さないため)。
 */
export function imageDefaultBody(
  fields: readonly ImageParameterField[],
  draft: ImageParameterDraft,
  saved: ImageParameterValues,
): ({ ok: true } & ImageDefaultBody) | { ok: false; error: string } {
  const parameters: ImageParameterValues = {};
  for (const field of fields) {
    const raw = (draft[field.name] ?? "").trim();
    if (raw === "") continue;
    if (field.kind === "integer") {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < field.min || value > field.max) {
        return { ok: false, error: `${field.name} は ${field.min} 以上 ${field.max} 以下の整数で入力してください` };
      }
      parameters[field.name] = value;
      continue;
    }
    if (!field.values.includes(raw)) return { ok: false, error: `${field.name} に指定できない値です: ${raw}` };
    parameters[field.name] = raw;
  }
  return { ok: true, parameters, unchanged: !imageDefaultDirty(fields, draft, saved) };
}

/** 既定の入力の面。入力欄・現在値・[保存] で送る本文・[既定を解除] の活性を 1 箇所で決める */
export interface ImageDefaultsScreen {
  /** 宣言に応じた入力欄。宣言が無いモデルは空（不明を既定として見せない） */
  fields: ImageParameterField[];
  /** 入力欄に出す値。下書きは選択中のモデルの分だけ使い、切替先は保存済みの既定を出す */
  values: ImageParameterDraft;
  /** 保存済みの既定（そのモデルの全項目。未保存は空） */
  saved: ImageParameterValues;
  /** 保存値と違うか */
  dirty: boolean;
  /** [保存] の本文。値が宣言の外なら error にする */
  body: ({ ok: true } & ImageDefaultBody) | { ok: false; error: string };
  /** [既定を解除] を押せるか。保存済みの既定が無ければ押しても変わらない */
  clearDisabled: boolean;
}

/**
 * 既定の入力欄を決める。下書きは編集したモデルの分だけを使うため、モデルを切り替えた時点で
 * 前のモデルの値は表示にも保存にも残らない（宣言外のキーを持ち越さない）。
 */
export function imageDefaultsScreen(
  settings: Pick<ContentSettingsResponse, "provider" | "image">,
  model: string,
  draft: ImageDefaultsDraft | null,
): ImageDefaultsScreen {
  const modelId = imageDefaultModelId(imageModelOptions(settings), model);
  const saved = modelId === null ? {} : (settings.image.parametersByModel[modelId] ?? {});
  const fields = imageParameterFields(imageModelParameterDeclarations(settings.image.models, model));
  const values = draft !== null && draft.model === model ? draft.values : imageParameterDraftOf(saved);
  return {
    fields,
    values,
    saved,
    dirty: imageDefaultDirty(fields, values, saved),
    body: imageDefaultBody(fields, values, saved),
    clearDisabled: Object.keys(saved).length === 0,
  };
}

/** [既定を解除] の本文。`{}` はそのモデルの既定だけを消し、他のモデルの既定には触らない */
export function imageDefaultClearSelection(
  options: readonly ImageModelOption[],
  model: string,
): UpdateContentImageBody | null {
  const selection = imageModelSelection(options, model);
  return selection === null ? null : { ...selection, parameters: {} };
}

/** 画像の [保存] を止める条件。モデルの差分だけでなく既定のパラメータの編集でも押せるようにする */
export function imageSelectionSaveDisabled(input: {
  busy: boolean;
  modelDirty: boolean;
  defaultsDirty: boolean;
  invalid: boolean;
}): boolean {
  return input.busy || input.invalid || !(input.modelDirty || input.defaultsDirty);
}
