/**
 * 設定 → コンテンツ生成の表示変換。DOM に依存しない純関数だけを置き、
 * 選択肢の組み立て・入力の後始末・保存後の文言・確認文をテストできるようにする。
 */
import type {
  ContentImageAuth,
  ContentImageSettings,
  ContentSettingsResponse,
  ContentSpeechSettings,
  ImageGenerationProvider,
  ImageModelPrice,
  ImageParameterValues,
  ModelPrice,
  ModelRef,
  SpeechModel,
  UpdateContentImageBody,
  UpdateContentSpeechBody,
} from "../types";
import type { ConfirmRequest } from "./confirmDialog";
import { imageModelParameterDeclarations, imageParameterDraftOf, imageParameterFields } from "./imageParameters";
import type { ImageParameterDraft, ImageParameterField } from "./imageParameters";
import { messageTimeLabel, type MessageTimeOptions } from "./messageTime";
import { modelRefKey, type ProviderBadge } from "./modelSettings";

/** コンテンツ生成の初期注記。キーの有無に関わらず出す */
export const CONTENT_SETTINGS_NOTE = "コンテンツ生成の設定はサーバーに保存され、再起動後も残ります。";

export const CONTENT_KEY_SAVED_NOTE =
  "コンテンツ生成のAPIキーを保存しました。新しい会話から generate_image・generate_speech・generate_bgm を使えます。";
export const CONTENT_KEY_DELETED_NOTE =
  "コンテンツ生成のAPIキーを削除しました。generate_image・generate_speech・generate_bgm は新しい会話から使えません。";
/** 画像の [保存] の成功注記。`onSaveSelection` はモデルと既定のパラメータ（値あり / 省略）を送るため、両方を書く */
export const CONTENT_IMAGE_SAVED_NOTE = "画像生成のモデルと既定を保存しました。";
export const CONTENT_SPEECH_SAVED_NOTE = "音声生成のモデルとボイスを保存しました。";
/** コストマスタの保存。取得はしないため「取得した」とは書かない */
export const CONTENT_COST_SAVED_NOTE = "コストマスタの設定を保存しました。価格の取得は [カタログ更新] で行います。";

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
 * Codex のサインイン案内。APIキーを画像利用の前提にしないため、登録先を名指しする。
 * 設定 → モデルの「Sign in with ChatGPT」は `openai` の資格情報で、Codex が読む `openai-codex` とは別物。
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
 * 認証が足りないときの案内。使えるときは null。
 * `image.auth` は値を持たないため、OpenRouter の「保存済みだが使えない」はキーの状態で書き分ける
 * （同じ画面のバッジ / 警告と同じ事実を、同じ語で伝える）。
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

/** 実行中の操作。null なら操作なし */
export type ContentSavingAction =
  | "enabled"
  | "key"
  | "delete"
  | "provider"
  | "selection"
  | "catalog"
  | "speech"
  | "cost";

/**
 * 有効 / 無効を保存したときの注記。ツール一覧はセッション作成時に固定するため、OFF は既存の会話に
 * 効くが、ON は OFF の間に作った会話には効かない（そこにはツールが無い）ことを書き分ける。
 */
export function contentEnabledNote(enabled: boolean): string {
  return enabled
    ? "コンテンツ生成を有効にしました。ツールを持つ既存の会話では次の呼び出しから generate_image・generate_speech・generate_bgm を使えます（OFF の間に作った会話にはツールが無いため、新しい会話で使えます）。"
    : "コンテンツ生成を無効にしました。既存の会話でも次の呼び出しから固定の文言で失敗します（キーと選択は残ります）。";
}

/**
 * APIキーの登録状態バッジ。`configured`（設定行の有無）ではなく `keyStored`（暗号文の有無）で出し、
 * 保存済みでも復号できないキーを「設定済み」と誤表示しない。同じ意味の表示をプロバイダータブと揃える。
 */
export function contentKeyStatusBadge(keyStored: boolean, keyAvailable = true): ProviderBadge {
  if (!keyStored) return { label: "未設定", tone: "muted" };
  return keyAvailable ? { label: "設定済み", tone: "ok" } : { label: "利用不可", tone: "warn" };
}

/**
 * 保存済みのキーを使えない理由。未評価 / 復号失敗の固定文言はサーバーが返したものをそのまま出し、
 * クライアントで原因を推測しない。
 */
export function contentKeyErrorNotice(
  settings: Pick<ContentSettingsResponse, "keyStored" | "keyAvailable" | "keyErrorMessage">,
): string | null {
  if (!settings.keyStored || settings.keyAvailable) return null;
  return settings.keyErrorMessage;
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

/** [カタログ更新] の結果。失敗した系統ごとに、一覧と価格のどちらが変わらないかを伝える */
export function contentCatalogRefreshNote(
  scope: "image" | "speech",
  errors: { image?: string | undefined; speech?: string | undefined; cost?: string | undefined },
): { text: string; error: boolean } {
  const parts: string[] = [];
  if (scope === "image" && errors.image !== undefined) {
    parts.push(`${errors.image}。表示中の一覧は変わりません。`);
  }
  if ((scope === "image" || scope === "speech") && errors.cost !== undefined) {
    parts.push("価格を取得できませんでした。表示中の価格は変わりません。");
  }
  if (scope === "speech" && errors.speech !== undefined) {
    parts.push(`${errors.speech}。表示中の一覧は変わりません。`);
  }
  return parts.length === 0
    ? { text: "モデル一覧を取得しました。", error: false }
    : { text: parts.join(" "), error: true };
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

/** `$0.00` を出さない。不明は `--`、宣言された無料は `$0` */
function formatPriceAmount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "--";
  if (value === 0) return "$0";
  const rounded = value >= 1 ? value.toFixed(2) : value.toFixed(4);
  return `$${String(Number(rounded))}`;
}

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

/** コストマスタの状態。未設定は出さず、停止中（前回取得）と未取得を別の文言にする */
export function costNotice(
  cost: ContentSettingsResponse["cost"],
  options: MessageTimeOptions = {},
): { text: string; tone: "muted" | "warn" } | null {
  if (cost.url === null) return null;
  const at = cost.fetchedAt === null ? "" : `（前回取得: ${messageTimeLabel(cost.fetchedAt, options)}）`;
  if (!cost.enabled) return { text: `コスト表示は停止中${at}`, tone: "warn" };
  if (cost.fetchedAt === null) {
    return { text: "価格はまだ取得していません（[カタログ更新] で取得します）", tone: "warn" };
  }
  return { text: `価格の最終取得: ${messageTimeLabel(cost.fetchedAt, options)}`, tone: "muted" };
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

/** 選択肢の表示名。name が空なら id だけ、同じ name が複数あるときは id を添えて一意にする */
function optionLabel(entry: { id: string; name: string }, duplicated: boolean): string {
  if (entry.name === "") return entry.id;
  return duplicated ? `${entry.name}（${entry.id}）` : entry.name;
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
 * 描画用の画像モデル選択肢。`imageModelOptions()` は全件のまま残し（PUT 本文の解決・既定の保存キー・
 * 試行の既定化が使う）、ここだけが `visible: false` を落とす。保存中の値が無効でも選択欄が空にならないよう、
 * 現在値だけは専用ラベルで残す。
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

/** 表示名の昇順。`localeCompare` はロケール依存を持ち込むため使わず、ASCII の単純比較にする */
function compareOptionLabels(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 画面に出ている画像モデル（`provider/id`）。下書きがあれば下書き、無ければ保存値。
 * 試行の開始と証拠の判定もこの 1 つを使う（保存前の試行が保存値のモデルで走ったり、
 * 別モデルの実績を現在の証拠として数えたりしないため）。未設定は空文字。
 */
export function imageScreenModel(input: { draft: string | null; savedModel: string }): string {
  return input.draft ?? input.savedModel;
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
        provider: provider ?? DEFAULT_CONTENT_PROVIDER,
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
 * [保存] で送る `parameters`。PUT は部分更新ではない（値あり = そのモデルの既定を丸ごと置き換える）ため、
 * 編集が 1 つでもあれば**宣言にある全項目**を返し、編集が無ければ `unchanged` にして省略させる。
 * `{}`（解除）をここで作らないのは、切替先モデルの既定を意図せず消さないため。
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
 * 起点は空欄と解釈できない値で 1.0、下限は `SPEECH_SPEED_MIN` で止める。
 */
export function speechSpeedStep(raw: string, delta: number): string {
  const current = speedUnits(raw.trim()) ?? SPEED_STANDARD;
  return String(Math.max(SPEED_FLOOR, current + Math.round(delta * SPEED_SCALE)) / SPEED_SCALE);
}
