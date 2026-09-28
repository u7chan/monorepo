/**
 * 設定 → モデルの表示変換。コンポーネントから切り出し、認証バッジ・並び・保存後の文言をテストできるようにする。
 * 保存先 (managed = DB) と実効値 (auth.source) と未反映 (degraded) は混ぜず、別々に出す。
 * 案内文 (degradedNotice) は、そのカードで実際に押せる回復操作 (resyncAvailable) と一致させる。
 * 「利用可能なモデル」の編集は、許可の正を `GET /api/settings/models` の allowedModels に保ち、
 * 下書きの組み立て・集計・確認文だけをここで純関数的に扱う (DOM に依存させない)。
 */
import type {
  ModelMutationResponse,
  ModelRef,
  ModelsSettingsResponse,
  ProviderAuthSetting,
  RuntimeModelsResponse,
} from "../types";

/** サーバーの検証と同じ境界。クライアントでも保存前に同じ理由で止める */
export const API_KEY_MIN_LENGTH = 8;
export const API_KEY_MAX_LENGTH = 2048;

/** provider メモの上限。秘密情報ではなく、長文でカードが伸びるのを抑える境界 */
export const MEMO_MAX_LENGTH = 500;

export const MODEL_SETTINGS_NOTE = "登録したキーは保存され、再起動後も使われます。登録済みのキーは再表示しません。";

export type ProviderBadgeTone = "ok" | "muted" | "warn";

export interface ProviderBadge {
  label: string;
  tone: ProviderBadgeTone;
}

/** 認証の出所ラベル。生のラベルや値は出さず、既知の分類だけを日本語にする */
function authSourceLabel(provider: ProviderAuthSetting): string {
  switch (provider.auth.source) {
    case "runtime":
      return "この画面で登録済み（実効）";
    case "environment": {
      const names = provider.auth.environmentVariables;
      return names.length > 0 ? `環境変数（${names.join(", ")}）` : "環境変数";
    }
    case "stored":
      return "保存済み（auth.json）";
    case "models_json_key":
      return "models.json のキー";
    case "models_json_command":
      return "models.json のコマンド";
    case "fallback":
      return "フォールバック";
    default:
      return "認証済み";
  }
}

/**
 * 認証状態のバッジ。未反映 (degraded) とカタログ外を先に見て、保存行の有無だけで「使える」と
 * 見せない。実効の出所は auth.source があればそちらを優先する。
 */
export function providerAuthBadge(provider: ProviderAuthSetting): ProviderBadge {
  if (provider.degraded === "apply") return { label: "保存済み（未反映）", tone: "warn" };
  if (provider.degraded === "remove") return { label: "削除が未反映", tone: "warn" };
  if (provider.orphan) return { label: provider.managed ? "カタログ外（保存済み）" : "カタログ外", tone: "warn" };
  if (provider.auth.configured) return { label: authSourceLabel(provider), tone: "ok" };
  return { label: provider.supportsOAuth ? "未設定（OAuth 可）" : "未設定", tone: "muted" };
}

/**
 * この画面から回復操作 (再同期) を出せるか。UI 外で張られた overlay を消さないため、
 * サーバーはカタログにある provider か degraded が remove の provider だけを受ける。
 */
export function resyncAvailable(provider: ProviderAuthSetting): boolean {
  if (!provider.degraded) return false;
  return !provider.orphan || provider.degraded === "remove";
}

/**
 * degraded の回復案内。このカードで実際に押せる操作だけを案内する ([再同期] を書くなら
 * resyncAvailable() が true であること)。カタログ外の apply は resync API も 400 にするため、
 * 削除かカタログ復帰へ導く。
 */
export function degradedNotice(provider: ProviderAuthSetting): string | undefined {
  if (provider.degraded === "apply") {
    return provider.orphan
      ? "保存済みのキーは実行中のランタイムへ反映できません（現在のカタログに無い provider です）。[削除] で保存を取り消すか、カタログに戻ってから登録し直してください。"
      : "保存済みのキーが実行中のランタイムへ反映されていません。[再同期] を実行するか、次回の変更か再起動で反映されます。";
  }
  if (provider.degraded === "remove") {
    return "保存行は削除済みですが、実行中のランタイムに前のキーが残っている可能性があります。[再同期] で削除を再試行できます。";
  }
  return undefined;
}

export interface ProviderGroups {
  /** 設定済み (認証済み / 保存済み / 利用可能モデルあり) を元の順で先頭に */
  configured: ProviderAuthSetting[];
  unconfigured: ProviderAuthSetting[];
}

export function availableCountOf(catalog: RuntimeModelsResponse | null, provider: string): number {
  const entry = catalog?.providers.find((candidate) => candidate.provider === provider);
  return entry?.models.filter((model) => model.available).length ?? 0;
}

/** 設定済みを先頭に、未設定は畳めるよう後ろへ分ける。並びはサーバーが返した順を保つ */
export function groupProviders(
  settings: ModelsSettingsResponse,
  catalog: RuntimeModelsResponse | null,
): ProviderGroups {
  const groups: ProviderGroups = { configured: [], unconfigured: [] };
  for (const provider of settings.providers) {
    // メモは SDK に触れないため「認証済み」ではないが、折りたたみの中に隠れると見つけられない
    const settled =
      provider.auth.configured ||
      provider.managed ||
      provider.memo !== null ||
      availableCountOf(catalog, provider.provider) > 0;
    (settled ? groups.configured : groups.unconfigured).push(provider);
  }
  return groups;
}

export function validateApiKey(value: string): string | undefined {
  if (value.length < API_KEY_MIN_LENGTH) return `APIキーは ${API_KEY_MIN_LENGTH} 文字以上で入力してください。`;
  if (value.length > API_KEY_MAX_LENGTH) return `APIキーは ${API_KEY_MAX_LENGTH} 文字以内で入力してください。`;
  return undefined;
}

/** メモは上限だけを見る。空文字はクリア（行を消して未設定へ戻す）として許す */
export function validateMemo(value: string): string | undefined {
  if (value.length > MEMO_MAX_LENGTH) return `メモは ${MEMO_MAX_LENGTH} 文字以内で入力してください。`;
  return undefined;
}

export type MutationAction = "save" | "delete" | "resync" | "availability" | "memo";

/** 削除の確認。既存の会話は自動でモデルを切り替えないため、影響を先に伝える */
export function deleteConfirmMessage(name: string): string {
  return `「${name}」のAPIキーを削除します。以降の送信が認証で失敗することがあり、未ロードの会話は復元時に別のモデルへ切り替わります。環境変数や auth.json の認証があれば、そちらが使われます。`;
}

/** 変更系の応答 (200) を操作の種類に応じた注記へ写す。applied_unsynced は再同期を案内する */
export function mutationNote(
  action: MutationAction,
  response: ModelMutationResponse,
  /** memo だけ: 空にして保存した (行を消した) かどうかで文言を分ける */
  memoCleared = false,
): { text: string; error: boolean } {
  const unsynced = response.state === "applied_unsynced";
  const suffix =
    "保存しましたが、実行中のランタイムへは未反映です。再同期を実行するか、次回の変更か再起動で反映されます。";
  switch (action) {
    case "save":
      return unsynced
        ? { text: `APIキーを${suffix}`, error: true }
        : { text: "APIキーを保存しました。モデル候補を更新しています。", error: false };
    case "delete":
      return unsynced
        ? { text: `削除は${suffix}`, error: true }
        : { text: "この画面で登録したAPIキーを削除しました。", error: false };
    case "resync":
      return unsynced
        ? { text: "再同期できませんでした。時間をおいてもう一度実行してください。", error: true }
        : { text: "再同期しました。モデル候補を更新しています。", error: false };
    case "availability":
      // SDK 呼び出しを含まないため applied_unsynced にはならない
      return { text: "利用可能なモデルを保存しました。新しい会話の候補を更新しています。", error: false };
    case "memo":
      // SDK に触れないため applied_unsynced にはならない
      return { text: memoCleared ? "メモを消しました。" : "メモを保存しました。", error: false };
  }
}

// --- 利用可能なモデル（許可リスト）とアプリ既定モデルの編集 ---

/** カタログのモデル参照を "provider/model" にする（API の allowedModels と同じ表記） */
export function modelRefKey(ref: ModelRef): string {
  return `${ref.provider}/${ref.id}`;
}

/** カタログの provider を落とさず 1 件ずつ扱うための平坦化 */
export interface CatalogModelEntry {
  key: string;
  name: string;
  available: boolean;
}

export function catalogModelEntries(catalog: RuntimeModelsResponse | null): CatalogModelEntry[] {
  return (catalog?.providers ?? []).flatMap((provider) =>
    provider.models.map((model) => ({
      key: modelRefKey({ provider: provider.provider, id: model.id }),
      name: model.name,
      available: model.available,
    })),
  );
}

/**
 * 編集の下書き。`allowed` は "provider/model" の一覧（API の allowedModels と同じ表記）で、
 * 空配列は「すべて外した」を表し、保存時に制限なしへ正規化する。`unrestricted` のときは使わない。
 */
export interface AvailabilityDraft {
  unrestricted: boolean;
  allowed: string[];
  /** 保存値としての既定モデル（`provider/id`）。未設定は null */
  defaultModel: string | null;
}

export function availabilityDraftFromSettings(settings: ModelsSettingsResponse): AvailabilityDraft {
  return {
    unrestricted: settings.allowedModels === null,
    allowed: settings.allowedModels ?? [],
    defaultModel: settings.defaultModel,
  };
}

/** 設定 API の配列参照が変わっても、保存値の要素内容が同じなら編集中の下書きを保つ */
export function sameAvailabilitySettings(
  left: Pick<ModelsSettingsResponse, "allowedModels" | "defaultModel">,
  right: Pick<ModelsSettingsResponse, "allowedModels" | "defaultModel">,
): boolean {
  if (left.defaultModel !== right.defaultModel) return false;
  if (left.allowedModels === null || right.allowedModels === null) return left.allowedModels === right.allowedModels;
  return (
    left.allowedModels.length === right.allowedModels.length &&
    left.allowedModels.every((model, index) => model === right.allowedModels?.[index])
  );
}

/** 下書きと保存値の差分。許可モデルは集合として扱い、制限なし中は allowed を比較しない */
export function availabilityDraftIsDirty(draft: AvailabilityDraft, initial: AvailabilityDraft): boolean {
  if (draft.unrestricted !== initial.unrestricted || draft.defaultModel !== initial.defaultModel) return true;
  if (draft.unrestricted) return false;
  const draftAllowed = new Set(draft.allowed);
  const initialAllowed = new Set(initial.allowed);
  return draftAllowed.size !== initialAllowed.size || [...draftAllowed].some((model) => !initialAllowed.has(model));
}

/** provider 単位の一括選択。available の値に関係なくカタログ全件を操作する */
export function setAvailabilityProviderModels(
  draft: AvailabilityDraft,
  providerId: string,
  selected: boolean,
  catalog: RuntimeModelsResponse | null,
): AvailabilityDraft {
  if (draft.unrestricted) return draft;
  const provider = catalog?.providers.find((entry) => entry.provider === providerId);
  const keys = provider?.models.map((model) => modelRefKey({ provider: providerId, id: model.id })) ?? [];
  if (keys.length === 0) return draft;

  const providerKeys = new Set(keys);
  const allowed = selected
    ? [...new Set([...draft.allowed, ...keys])]
    : draft.allowed.filter((key) => !providerKeys.has(key));
  const defaultModel =
    !selected && draft.defaultModel && providerKeys.has(draft.defaultModel) ? null : draft.defaultModel;
  return { ...draft, allowed, defaultModel };
}

/** 制限なしから選択へ戻すときの初期値。全件を選んだ状態から外していけるようにカタログ全件を入れる */
export function availabilityDraftWithAllModels(catalog: RuntimeModelsResponse | null): string[] {
  return catalogModelEntries(catalog).map((entry) => entry.key);
}

/** 保存形へ正規化する。空配列は「制限なし」へ寄せる（サーバーと同じ扱い） */
export function normalizeAllowedModels(allowed: string[]): string[] | null {
  return allowed.length > 0 ? allowed : null;
}

export function isModelAllowed(allowed: string[], key: string): boolean {
  return allowed.includes(key);
}

/** 保存値・下書きにあるが、現在のカタログに無いエントリ。保存すると 400 になるため画面で消す */
export function allowedModelsOutsideCatalog(allowed: string[], catalog: RuntimeModelsResponse | null): string[] {
  const keys = new Set(catalogModelEntries(catalog).map((entry) => entry.key));
  return allowed.filter((key) => !keys.has(key));
}

export interface AvailabilityCounts {
  /** カタログ全件 */
  catalog: number;
  /** 下書きで許可しているモデル数（制限なしはカタログ全件） */
  allowed: number;
  /** 許可しているうち、いま利用可能なモデル数 */
  available: number;
}

/**
 * 下書きの集計。カタログを取得できないときは undefined を返し、画面は編集自体を止める
 * （呼び出し側は catalogError で編集可否を判定する）。
 */
export function availabilityCounts(
  draft: AvailabilityDraft,
  catalog: RuntimeModelsResponse | null,
): AvailabilityCounts | undefined {
  if (!catalog) return undefined;
  const entries = catalogModelEntries(catalog);
  const allowed = draft.unrestricted ? entries : entries.filter((entry) => draft.allowed.includes(entry.key));
  return {
    catalog: entries.length,
    allowed: allowed.length,
    available: allowed.filter((entry) => entry.available).length,
  };
}

export interface AvailabilityNotice {
  /** 常時出す警告（既定に選んだモデルが未認証のとき） */
  warning?: string;
  /** [保存] を押したときの確認。確認が不要なら undefined */
  confirm?: string;
}

/**
 * 保存前の警告と確認文。確認の出し方 (画面内確認) はコンポーネント側が
 * `availabilitySaveOnSubmit()` で決め、ここは DOM に依存せず文言だけを組み立てる。
 */
export function availabilityNotice(
  draft: AvailabilityDraft,
  catalog: RuntimeModelsResponse | null,
): AvailabilityNotice {
  const counts = availabilityCounts(draft, catalog);
  if (!counts) return {};
  const defaultEntry = draft.defaultModel
    ? catalogModelEntries(catalog).find((entry) => entry.key === draft.defaultModel)
    : undefined;
  // ここでの未認証は「カタログにはあるが available でない」を指す（認証状態の詳細はサーバーが持つ）
  const defaultUnavailable = Boolean(draft.defaultModel && defaultEntry && !defaultEntry.available);

  const reasons: string[] = [];
  if (!draft.unrestricted && draft.allowed.length === 0) {
    reasons.push("利用可能なモデルをすべて外したので、保存すると制限なし（全モデル）へ戻ります");
  } else if (counts.allowed > 0 && counts.available === 0) {
    reasons.push("この保存で利用可能なモデルが 0 件になり、新しい会話を作成できなくなります");
  }
  if (defaultUnavailable) reasons.push("既定に選んだモデルは現在利用できません（キー未設定または未認証です）");

  return {
    ...(defaultUnavailable
      ? {
          warning:
            "既定に選んだモデルは現在利用できません。キー未設定または未認証のまま保存すると、新しい会話の作成が 503 で失敗します。",
        }
      : {}),
    ...(reasons.length > 0 ? { confirm: `${reasons.join("。")}。保存しますか？` } : {}),
  };
}

/**
 * 利用可能なモデルの保存操作の状態。確認が要るときは 1 回目の押下で画面内確認を出し、同意後の
 * [保存する] で送る（ネイティブの `window.confirm` は使わない。判定を DOM なしで検証できるようにする）。
 */
export interface AvailabilitySaveState {
  confirming: boolean;
}

export const AVAILABILITY_SAVE_INITIAL: AvailabilitySaveState = { confirming: false };

/** [保存] を押したときの次の一手。send が false なら画面内確認を出すだけにして、PUT を送らない */
export function availabilitySaveOnSubmit(
  state: AvailabilitySaveState,
  notice: AvailabilityNotice,
): { state: AvailabilitySaveState; send: boolean } {
  if (notice.confirm && !state.confirming) return { state: { confirming: true }, send: false };
  return { state: AVAILABILITY_SAVE_INITIAL, send: true };
}

/** 画面内確認に出す文言（確認を出していないときは undefined） */
export function availabilitySaveConfirmMessage(
  state: AvailabilitySaveState,
  notice: AvailabilityNotice,
): string | undefined {
  return state.confirming ? notice.confirm : undefined;
}

export interface AvailabilityRow {
  key: string;
  /** カタログの表示名 */
  name: string;
  available: boolean;
  checked: boolean;
}

/** provider ごとの折りたたみ 1 件。カタログの入力順を保つ */
export interface AvailabilityGroup {
  provider: string;
  authConfigured: boolean;
  rows: AvailabilityRow[];
}

export function availabilityGroups(
  draft: AvailabilityDraft,
  catalog: RuntimeModelsResponse | null,
): AvailabilityGroup[] {
  return (catalog?.providers ?? [])
    .map((provider, index) => ({
      index,
      availableCount: provider.models.filter((model) => model.available).length,
      group: {
        provider: provider.provider,
        authConfigured: provider.auth.configured,
        rows: provider.models.map((model) => {
          const key = modelRefKey({ provider: provider.provider, id: model.id });
          return {
            key,
            name: model.name,
            available: model.available,
            checked: draft.unrestricted || draft.allowed.includes(key),
          };
        }),
      },
    }))
    .sort((left, right) => right.availableCount - left.availableCount || left.index - right.index)
    .map(({ group }) => group);
}

export interface AvailabilityChoice {
  key: string;
  label: string;
  available: boolean;
  inCatalog: boolean;
}

/** 既定モデルの選択肢。カタログ外の保存値も選べる状態のまま残す（削除するまで保存できない） */
export function availabilityDefaultChoices(
  draft: AvailabilityDraft,
  catalog: RuntimeModelsResponse | null,
): AvailabilityChoice[] {
  const entries = catalogModelEntries(catalog);
  const keys = draft.unrestricted ? availabilityDraftWithAllModels(catalog) : draft.allowed;
  const seen = new Set<string>();
  const choices: AvailabilityChoice[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = entries.find((candidate) => candidate.key === key);
    choices.push({
      key,
      label: entry ? `${entry.name}（${key}）` : `${key}（カタログ外）`,
      available: entry?.available ?? false,
      inCatalog: Boolean(entry),
    });
  }
  return choices;
}
