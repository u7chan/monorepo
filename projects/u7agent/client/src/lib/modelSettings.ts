/**
 * 設定 → モデルの表示変換。コンポーネントから切り出し、認証バッジ・並び・保存後の文言をテストできるようにする。
 * 保存先 (managed = DB) と実効値 (auth.source) と未反映 (degraded) は混ぜず、別々に出す。
 * 案内文 (degradedNotice) は、そのカードで実際に押せる回復操作 (resyncAvailable) と一致させる。
 * モデル候補（選択）の編集は、選択の正を `GET /api/settings/models` の allowedModels に保ち、
 * 下書きの組み立て・集計・確認文だけをここで純関数的に扱う (DOM に依存させない)。
 */
import type {
  ModelMutationResponse,
  ModelRef,
  ModelsSettingsResponse,
  ProviderAuthSetting,
  RuntimeModelsResponse,
  SessionSummary,
} from "../types";
import type { ConfirmRequest } from "./confirmDialog";

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

/**
 * この provider を使っている会話の数と最終使用。最終使用は保存値ではなく、セッション一覧の
 * `model` + `lastUsedAt` から導出する (会話の最終更新であって、取り消し・削除で減り得る)。
 */
export interface ProviderUsage {
  /** この provider のモデルを使っている会話の数 */
  sessions: number;
  /** その中で最も新しい lastUsedAt。1 件も無ければ null */
  lastUsedAt: number | null;
}

/**
 * provider ごとの使用状況。`model` は `provider/model` 形式で、区切りは最初の `/` だけ
 * (model id に `/` を含み得る。server の parseModelRef と同じ規則)。`model` の無い会話は母数から除く。
 */
export function providerUsage(sessions: SessionSummary[], provider: string): ProviderUsage {
  let count = 0;
  let lastUsedAt: number | null = null;
  for (const session of sessions) {
    const model = session.model;
    if (!model) continue;
    const slash = model.indexOf("/");
    // provider が空 / id が空の壊れた値は数えない (parseModelRef と同じ扱い)
    if (slash <= 0 || slash === model.length - 1) continue;
    if (model.slice(0, slash) !== provider) continue;
    count += 1;
    if (lastUsedAt === null || session.lastUsedAt > lastUsedAt) lastUsedAt = session.lastUsedAt;
  }
  return { sessions: count, lastUsedAt };
}

// --- provider 詳細の入力下書き（両タブの親が持つ） ---

/** provider 詳細の入力下書き。タブ切替・provider 切替・検索を跨いで親が保つ */
export interface ProviderDraft {
  apiKey: string;
  memo: string;
}

/** 下書きがまだ無い provider の初期値。メモは保存値から始める */
export function providerDraftBase(provider: ProviderAuthSetting): ProviderDraft {
  return { apiKey: "", memo: provider.memo ?? "" };
}

/**
 * 入力欄に出す下書き。まだ触っていない provider は保存値 (メモ) から作り、触った後は親の下書きを使う。
 * 子を再マウントしても編集中の値を失わないための入口 (provider.memo で再初期化しない)。
 */
export function providerDraftOf(drafts: Record<string, ProviderDraft>, provider: ProviderAuthSetting): ProviderDraft {
  return drafts[provider.provider] ?? providerDraftBase(provider);
}

/**
 * 下書きをフィールド単位で更新する。`base` は下書きがまだ無いときの初期値。
 * `patch` に含まれないフィールドは最新の下書きの値を保つため、保存の待機中に他方へ入力された値や、
 * 保存値の外部変化で同期したくないフィールドを古いスナップショットで上書きしない。
 * 内容が同じなら同じ参照を返し、不要な再レンダーを作らない。
 */
export function withProviderDraft(
  drafts: Record<string, ProviderDraft>,
  provider: string,
  base: ProviderDraft,
  patch: Partial<ProviderDraft>,
): Record<string, ProviderDraft> {
  const current = drafts[provider] ?? base;
  const next = { ...current, ...patch };
  if (current.apiKey === next.apiKey && current.memo === next.memo) return drafts;
  return { ...drafts, [provider]: next };
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
export function deleteConfirmRequest(name: string): ConfirmRequest {
  return {
    kind: "confirm",
    title: "APIキーを削除",
    subject: { label: "削除する provider", value: name },
    body: [
      "以降の送信が認証で失敗することがあり、未ロードの会話は復元時に別のモデルへ切り替わります。",
      "環境変数や auth.json の認証があれば、そちらが使われます。",
    ],
    confirmLabel: "削除する",
    danger: true,
  };
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

// --- モデル候補（選択リスト）とアプリ既定モデルの編集 ---

/** カタログのモデル参照を "provider/model" にする（API の allowedModels と同じ表記） */
export function modelRefKey(ref: ModelRef): string {
  return `${ref.provider}/${ref.id}`;
}

/**
 * "provider/model" から provider を取り出す。区切りは最初の `/` だけ
 * (model id に `/` を含み得る。server の parseModelRef と同じ規則)。
 */
export function modelKeyProvider(key: string): string {
  const slash = key.indexOf("/");
  return slash > 0 ? key.slice(0, slash) : key;
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
 * モデル候補の下書き。`allowed` は "provider/model" の明示リストで、空配列は UI から送らない
 * (API は空配列を制限なしへ正規化するため、画面側で 0 件の保存を止める)。
 */
export interface AvailabilityDraft {
  /** 選択したモデル。表示は API の allowedModels と同じ表記 */
  allowed: string[];
  /** 保存値としての既定モデル（`provider/id`）。未設定は null */
  defaultModel: string | null;
}

/**
 * 候補に出さないエントリを下書きから落とす。表示 (`candidateGroups()`) と同じ「認証済み provider か」
 * の判定を使い、画面に出ない選択が保存へ残らないようにする。カタログ外のエントリは保存が 400 に
 * なるため残し、行と警告を出して外せるようにする。カタログを取得できていないときは判定できないので
 * そのまま返す。
 */
export function pruneAvailabilityDraft(
  draft: AvailabilityDraft,
  catalog: RuntimeModelsResponse | null,
): AvailabilityDraft {
  if (catalog === null) return draft;
  const authenticated = new Set(
    catalog.providers.filter((provider) => provider.auth.configured).map((provider) => provider.provider),
  );
  const outsideCatalog = new Set(allowedModelsOutsideCatalog(draft.allowed, catalog));
  const allowed = draft.allowed.filter((key) => authenticated.has(modelKeyProvider(key)) || outsideCatalog.has(key));
  // 既定が選択外になると保存が 400 になるため、落とした選択を指す既定は未設定へ戻す
  const defaultModel = draft.defaultModel !== null && !allowed.includes(draft.defaultModel) ? null : draft.defaultModel;
  if (allowed.length === draft.allowed.length && defaultModel === draft.defaultModel) return draft;
  return { allowed, defaultModel };
}

/**
 * 下書きの初期値。`allowedModels === null`（旧・制限なし）は「利用可能な全モデルが選択済み」
 * として明示リストへ展開する。保存済みの既定モデルがその集合に無い場合は 1 件だけ足す
 * (足さないと、別の差分を保存した時点で既定モデルが選択外になり 400 になる)。最後に認証の無い
 * provider の選択 (`pruneAvailabilityDraft()`) を落とし、表示と保存の対象を認証済みへ揃える。
 */
export function availabilityDraftFromSettings(
  settings: Pick<ModelsSettingsResponse, "allowedModels" | "defaultModel">,
  catalog: RuntimeModelsResponse | null,
): AvailabilityDraft {
  const allowed =
    settings.allowedModels === null
      ? catalogModelEntries(catalog)
          .filter((entry) => entry.available)
          .map((entry) => entry.key)
      : [...settings.allowedModels];
  if (settings.defaultModel && !allowed.includes(settings.defaultModel)) allowed.push(settings.defaultModel);
  return pruneAvailabilityDraft({ allowed, defaultModel: settings.defaultModel }, catalog);
}

/**
 * 下書きの比較基準。`settings` はこの基準を作った保存値、`builtWithCatalog` はカタログつきで
 * 初期値を作ったか (null の展開と、認証の無い provider の除去にカタログが要る)。
 */
export interface AvailabilityDraftState {
  settings: Pick<ModelsSettingsResponse, "allowedModels" | "defaultModel">;
  initial: AvailabilityDraft;
  builtWithCatalog: boolean;
}

/**
 * 保存値とカタログから下書きの比較基準を作る。保存値 (allowedModels / defaultModel) が変わったときと、
 * カタログ無しで作った初期値をまだカタログつきで作り直していないときだけ作り直し、それ以外は同じ
 * 参照を返す。カタログの更新 (キー操作での再取得・取得失敗) だけでは、編集中の下書きを置換しない。
 */
export function availabilityDraftState(
  previous: AvailabilityDraftState | null,
  settings: Pick<ModelsSettingsResponse, "allowedModels" | "defaultModel">,
  catalog: RuntimeModelsResponse | null,
): AvailabilityDraftState {
  // カタログが無い間は保存値のまま作り、初回の到着で 1 回だけ作り直す (初回の再取得では作り直さない)
  const needsCatalogBuild = catalog !== null && !(previous?.builtWithCatalog ?? false);
  if (previous && !needsCatalogBuild && sameAvailabilitySettings(previous.settings, settings)) return previous;
  return {
    settings,
    initial: availabilityDraftFromSettings(settings, catalog),
    builtWithCatalog: catalog !== null || (previous?.builtWithCatalog ?? false),
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

/** 下書きと保存値の差分。選択は集合として扱い、並び順だけの違いは差分にしない */
export function availabilityDraftIsDirty(draft: AvailabilityDraft, initial: AvailabilityDraft): boolean {
  if (draft.defaultModel !== initial.defaultModel) return true;
  const draftAllowed = new Set(draft.allowed);
  const initialAllowed = new Set(initial.allowed);
  return draftAllowed.size !== initialAllowed.size || [...draftAllowed].some((model) => !initialAllowed.has(model));
}

/**
 * provider 単位の一括操作。[すべて解除] はカタログに無い provider でも保存済みエントリを外せる
 * ように、カタログではなく下書きから対象を引く。
 */
export function setAvailabilityProviderModels(
  draft: AvailabilityDraft,
  providerId: string,
  selected: boolean,
  catalog: RuntimeModelsResponse | null,
): AvailabilityDraft {
  const provider = catalog?.providers.find((entry) => entry.provider === providerId);
  const providerKeys = selected
    ? (provider?.models ?? []).map((model) => modelRefKey({ provider: providerId, id: model.id }))
    : draft.allowed.filter((key) => modelKeyProvider(key) === providerId);
  if (providerKeys.length === 0) return draft;

  const selectedKeys = new Set(providerKeys);
  const allowed = selected
    ? [...new Set([...draft.allowed, ...providerKeys])]
    : draft.allowed.filter((key) => !selectedKeys.has(key));
  const defaultModel =
    !selected && draft.defaultModel && modelKeyProvider(draft.defaultModel) === providerId ? null : draft.defaultModel;
  return { ...draft, allowed, defaultModel };
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
  /** 表示集合（認証済み provider のカタログ + 選択済みエントリ）のうち利用可能なモデル数 */
  available: number;
  /** 選択中のモデル数 */
  selected: number;
}

/** 候補の集計。状態表示は絞り込み前の groups から数える */
export function availabilityCounts(groups: CandidateGroup[]): AvailabilityCounts {
  let available = 0;
  let selected = 0;
  for (const group of groups) {
    for (const row of group.rows) {
      if (row.available) available += 1;
      if (row.checked) selected += 1;
    }
  }
  return { available, selected };
}

export interface AvailabilityNotice {
  /** 常時出す警告（既定に選んだモデルが未認証のとき） */
  warning?: string;
  /** [保存] を押したときの確認。確認が不要なら undefined */
  confirm?: string;
}

/**
 * 保存前の警告と確認文。選択 0 件はコンポーネントが保存自体を止めるためここでは扱わない。
 * 確認の出し方 (画面内確認) は `availabilitySaveOnSubmit()` で決め、ここは DOM に依存せず
 * 文言だけを組み立てる。
 */
export function availabilityNotice(
  draft: AvailabilityDraft,
  catalog: RuntimeModelsResponse | null,
): AvailabilityNotice {
  if (!catalog) return {};
  const entries = catalogModelEntries(catalog);
  const selected = new Set(draft.allowed);
  const availableSelected = entries.filter((entry) => selected.has(entry.key) && entry.available).length;
  const defaultEntry = draft.defaultModel ? entries.find((entry) => entry.key === draft.defaultModel) : undefined;
  // ここでの未認証は「カタログにはあるが available でない」を指す（認証状態の詳細はサーバーが持つ）
  const defaultUnavailable = Boolean(draft.defaultModel && defaultEntry && !defaultEntry.available);

  const reasons: string[] = [];
  if (selected.size > 0 && availableSelected === 0) {
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

/** モデル候補の 1 行。checkbox / モデル名 / ID / 利用可能 の 4 列の材料 */
export interface CandidateRow {
  key: string;
  /** カタログの表示名。カタログ外のエントリは key をそのまま出す */
  name: string;
  available: boolean;
  checked: boolean;
  /** 現在のカタログに無い保存済みエントリ */
  outsideCatalog: boolean;
}

/** モデル候補の provider ごとの折りたたみ 1 件 */
export interface CandidateGroup {
  provider: string;
  /** 表示名。設定 API の provider 行が無ければ provider id */
  name: string;
  badge: ProviderBadge;
  /** 認証済み provider。false の group は保存済みの選択だけを警告付きで出す */
  authenticated: boolean;
  /** 保存済みの選択を残したままにしている理由（未認証・カタログ外） */
  warning?: string;
  /** カタログ全件のうち利用可能な数（catalogCount と合わせて a/b の表記に使う） */
  availableCount: number;
  catalogCount: number;
  /** 下書き全体の選択数（表示行ではなく下書きから数える） */
  selectedCount: number;
  rows: CandidateRow[];
}

/**
 * モデル候補の表示集合。認証済み provider のカタログ全件と、カタログ外の残存エントリ（外すまで
 * 保存できないため必ず出す）の和集合にする。認証の無い provider は下書きに選択が残っていても
 * 出さない（`pruneAvailabilityDraft()` と同じ判定で、表示と保存の対象を揃える）。並びは
 * 「プロバイダー」タブと同じカタログ順にし、カタログに無い残存は下書きの順でうしろへ足す（表示順だけ）。
 */
export function candidateGroups(
  draft: AvailabilityDraft,
  catalog: RuntimeModelsResponse | null,
  settings: ModelsSettingsResponse,
): CandidateGroup[] {
  const allowed = new Set(draft.allowed);
  const outsideCatalog = new Set(allowedModelsOutsideCatalog(draft.allowed, catalog));
  const selectedCounts = new Map<string, number>();
  for (const key of allowed) {
    const provider = modelKeyProvider(key);
    selectedCounts.set(provider, (selectedCounts.get(provider) ?? 0) + 1);
  }
  const catalogProviders = new Map((catalog?.providers ?? []).map((entry) => [entry.provider, entry]));
  const settingsProviders = new Map(settings.providers.map((entry) => [entry.provider, entry]));

  // 表示する provider はカタログ順の認証済み → 下書きにしか無い provider（下書きの順）
  const order: string[] = [];
  const known = new Set<string>();
  for (const provider of catalog?.providers ?? []) {
    if (!provider.auth.configured || known.has(provider.provider)) continue;
    known.add(provider.provider);
    order.push(provider.provider);
  }
  for (const key of draft.allowed) {
    const provider = modelKeyProvider(key);
    if (known.has(provider)) continue;
    known.add(provider);
    order.push(provider);
  }

  const groups = order.map((provider): CandidateGroup => {
    const catalogProvider = catalogProviders.get(provider);
    const setting = settingsProviders.get(provider);
    const authenticated = catalogProvider?.auth.configured === true;
    const rows: CandidateRow[] = [];
    const seen = new Set<string>();
    if (authenticated) {
      for (const model of catalogProvider?.models ?? []) {
        const key = modelRefKey({ provider, id: model.id });
        seen.add(key);
        rows.push({
          key,
          name: model.name,
          available: model.available,
          checked: allowed.has(key),
          outsideCatalog: false,
        });
      }
    }
    // カタログ行として出ていないエントリ。認証済み provider は選択済み全部、未認証 provider は
    // カタログ外の残存だけを出す（認証の無い provider の選択は `pruneAvailabilityDraft()` が落とす）
    for (const key of draft.allowed) {
      if (modelKeyProvider(key) !== provider || seen.has(key)) continue;
      if (!authenticated && !outsideCatalog.has(key)) continue;
      const model = catalogProvider?.models.find((entry) => modelRefKey({ provider, id: entry.id }) === key);
      rows.push({
        key,
        name: model?.name ?? key,
        available: model?.available ?? false,
        checked: true,
        outsideCatalog: outsideCatalog.has(key),
      });
    }
    const catalogModels = catalogProvider?.models ?? [];
    return {
      provider,
      name: setting?.name ?? provider,
      badge: setting ? providerAuthBadge(setting) : { label: catalogProvider ? "未認証" : "カタログ外", tone: "warn" },
      authenticated,
      ...(authenticated
        ? rows.some((row) => row.outsideCatalog)
          ? { warning: "現在のカタログに無いモデルが保存されています。外すまで保存できません。" }
          : {}
        : catalogProvider
          ? {
              warning:
                "認証が設定されていない provider です。カタログに無い保存済みの選択だけを表示しています。外すまで保存できません。",
            }
          : { warning: "現在のカタログに無い provider です。保存済みの選択を外すことで削除できます。" }),
      availableCount: catalogModels.filter((model) => model.available).length,
      catalogCount: catalogModels.length,
      selectedCount: selectedCounts.get(provider) ?? 0,
      rows,
    };
  });

  return groups.filter((group) => group.authenticated || group.rows.length > 0);
}

/**
 * 検索と「選択済みのみ」で候補を絞る。検索は DOM ではなくカタログのデータ（provider / モデル名 /
 * ID）に当て、当たった provider だけを残す（コンポーネントは検索中にそれを自動展開する）。
 */
export function filterCandidateGroups(
  groups: CandidateGroup[],
  query: string,
  selectedOnly: boolean,
): CandidateGroup[] {
  const needle = query.trim().toLowerCase();
  const matched = (text: string) => text.toLowerCase().includes(needle);
  return groups
    .map((group) => {
      const providerMatched = needle !== "" && (matched(group.provider) || matched(group.name));
      const rows = group.rows.filter((row) => {
        if (selectedOnly && !row.checked) return false;
        return needle === "" || providerMatched || matched(row.name) || matched(row.key);
      });
      return { ...group, rows };
    })
    .filter((group) => group.rows.length > 0);
}

export interface AvailabilityChoice {
  key: string;
  name: string;
  available: boolean;
  inCatalog: boolean;
}

/** 既定モデルの候補。選択済みモデルだけを並べ、カタログ外の保存値も外すまで残す */
export function availabilityDefaultChoices(
  draft: AvailabilityDraft,
  catalog: RuntimeModelsResponse | null,
): AvailabilityChoice[] {
  const entries = catalogModelEntries(catalog);
  const seen = new Set<string>();
  const choices: AvailabilityChoice[] = [];
  for (const key of draft.allowed) {
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = entries.find((candidate) => candidate.key === key);
    choices.push({
      key,
      name: entry?.name ?? key,
      available: entry?.available ?? false,
      inCatalog: entry !== undefined,
    });
  }
  return choices;
}

/** 既定モデルのピッカーの先頭に残す「未設定」の表示 */
export const UNSET_DEFAULT_MODEL_LABEL = "未設定";

/** 既定モデルの保存が無いときの案内。設定 → モデル と入力欄の Model の両方の入口を示す */
export const MODEL_UNSET_GUIDE =
  "アプリ既定モデルが未設定です。設定 → モデル で既定モデルを選ぶか、入力欄の Model から使用するモデルを選んでください。";

/** 既定モデルのピッカーの 1 行。key null は「未設定」 */
export interface DefaultModelOption {
  key: string | null;
  name: string;
  /** ID 列に出す文字列（未設定は空） */
  detail: string;
  available: boolean;
  inCatalog: boolean;
}

/** 既定モデルのピッカーの候補。先頭は常に「未設定」で、その後に選択済みモデルを並べる */
export function defaultModelOptions(
  draft: AvailabilityDraft,
  catalog: RuntimeModelsResponse | null,
): DefaultModelOption[] {
  return [
    { key: null, name: UNSET_DEFAULT_MODEL_LABEL, detail: "", available: true, inCatalog: true },
    ...availabilityDefaultChoices(draft, catalog).map((choice) => ({
      key: choice.key,
      name: choice.name,
      detail: choice.key,
      available: choice.available,
      inCatalog: choice.inCatalog,
    })),
  ];
}

/** 既定モデルのピッカーの検索。名前と ID を見る（未設定は「未設定」の語で当たる） */
export function filterDefaultModelOptions(options: DefaultModelOption[], query: string): DefaultModelOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return options;
  return options.filter((option) => `${option.name} ${option.detail}`.toLowerCase().includes(needle));
}
