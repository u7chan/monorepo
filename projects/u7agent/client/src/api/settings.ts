import { ALL_BACKUP_TARGETS } from "../lib/backupFlow";
import { ApiError, client, ensureOk, read } from "./http";
import type {
  ArchiveSettingsResponse,
  BackupExportCheck,
  BackupResetResult,
  BackupRestorePlan,
  BackupRestoreResult,
  BackupTarget,
  CloudflareConnectionCheckResponse,
  CloudflareMutationResponse,
  CloudflareSettingsResponse,
  CreateCustomProviderBody,
  CustomProviderProbeBody,
  CustomProviderProbeResponse,
  ContentCatalogRefreshResponse,
  ContentMutationResponse,
  ContentSettingsResponse,
  ContentTrialDeleteResponse,
  ContentTrialListResponse,
  ContentTrialResponse,
  ContentTrialStartResponse,
  CreateContentTrialBody,
  GitSettingsMutationResponse,
  GitSettingsResponse,
  ModelCatalogRefreshResponse,
  ModelMutationResponse,
  ModelsSettingsResponse,
  NotificationResult,
  NotificationsResponse,
  TitleSummarySettingsResponse,
  TitleSummaryTestResponse,
  UpdateCloudflareSettingsBody,
  UpdateContentCostBody,
  UpdateContentImageBody,
  UpdateContentImageProviderBody,
  UpdateContentSpeechBody,
  UpdateCustomProviderBody,
  UpdateModelAvailabilityBody,
  UpdateNotificationsBody,
  UpdateTitleSummaryBody,
  VoiceInputMutationResponse,
  VoiceInputSettingsResponse,
  VoiceInputTestResponse,
  WebSearchMutationResponse,
  WebSearchProviderId,
  WebSearchSettingsResponse,
  WebSearchTestResponse,
} from "../types";

/**
 * 通知設定。Webhook URL は write-only で、応答には保存の有無（`configured`）と復号の状態（`webhookAvailable` / `webhookEvaluated` / `webhookErrorMessage`）だけを載せる。
 * テスト送信は保存済み設定で 1 通送り、Discord 側の失敗も結果 (ok: false) として 200 で返る。
 */
export const getNotifications = async (): Promise<NotificationsResponse> => {
  const res = await ensureOk(client.api.notifications.$get());
  return res.json();
};

export const updateNotifications = async (input: UpdateNotificationsBody): Promise<NotificationsResponse> => {
  const res = await ensureOk(client.api.notifications.$put({ json: input }));
  return res.json();
};

export const testNotification = async (): Promise<NotificationResult> => {
  const res = await ensureOk(client.api.notifications.test.$post());
  return res.json();
};

/**
 * アーカイブの除外名。`excludeNames` は常に実効値で、`overridden` が false のときは既定の一覧を使っている。
 * 保存（PUT）と既定に戻す（DELETE）も同じ形を返すため、画面は応答をそのまま次の状態にできる。
 */
export const getArchiveSettings = async (): Promise<ArchiveSettingsResponse> => {
  const res = await ensureOk(client.api.settings.archive.$get());
  return res.json();
};

export const updateArchiveSettings = async (excludeNames: string[]): Promise<ArchiveSettingsResponse> => {
  const res = await ensureOk(client.api.settings.archive.$put({ json: { excludeNames } }));
  return res.json();
};

/** 保存行を消して未設定へ戻す（既定名を保存し直さないので、将来の既定の追加に追随する） */
export const resetArchiveSettings = async (): Promise<ArchiveSettingsResponse> => {
  const res = await ensureOk(client.api.settings.archive.$delete());
  return res.json();
};

/**
 * 設定 → モデルのプロバイダー認証状態（純粋読取）。キー値は含まれない。
 * モデル数と一覧は別途 `getRuntimeModels()` が持ち、片方の失敗が他方を隠さない。
 */
export const getModelsSettings = async (): Promise<ModelsSettingsResponse> => {
  const res = await ensureOk(client.api.settings.models.$get());
  return res.json();
};

/**
 * pi.dev のモデルカタログを取り直す。取得できなくても 200 で、失敗は `catalogError` にだけ載る
 * （一覧は手元に残る）。設定は変わらないため、応答は `GET /api/runtime/models` と同じ形 + この 1 フィールド。
 */
export const refreshModelCatalog = () =>
  read<ModelCatalogRefreshResponse>(client.api.settings.models.catalog.refresh.$post());

/**
 * 利用可能なモデルとアプリ既定モデルの一括保存。両方 null は「未設定へ戻す」。
 * SDK 呼び出しを含まないため `applied_unsynced` にはならない。
 */
export const putModelAvailability = (input: UpdateModelAvailabilityBody) =>
  read<ModelMutationResponse>(client.api.settings.models.allowed.$put({ json: input }));

/** APIキーの登録（既存は上書き）。保存は確定し、SDK へ未反映なら `state: "applied_unsynced"` で返る */
export const putProviderApiKey = (provider: string, apiKey: string) =>
  read<ModelMutationResponse>(
    client.api.settings.models[":provider"].key.$put({ param: { provider }, json: { apiKey } }),
  );

/** この画面で登録したキーの削除。この画面の管理外（行が無い）は 400 */
export const deleteProviderApiKey = (provider: string) =>
  read<ModelMutationResponse>(client.api.settings.models[":provider"].key.$delete({ param: { provider } }));

/**
 * provider のメモ（人間用の任意文字列）。SDK に触れないため常に `state: "applied"`。
 * 空文字を送ると行が消えて `memo: null` に戻る。
 */
export const putProviderMemo = (provider: string, memo: string) =>
  read<ModelMutationResponse>(
    client.api.settings.models[":provider"].memo.$put({ param: { provider }, json: { memo } }),
  );

/**
 * カスタムプロバイダー（オンメモリ）の登録。DB へは書かないため常に `state: "applied"`。
 * 検証失敗は 400、SDK へ反映できないときは 503 `{ error }`（`not_stored` は付かない）。
 */
export const postCustomProvider = (input: CreateCustomProviderBody) =>
  read<ModelMutationResponse>(client.api.settings["custom-providers"].$post({ json: input }));

/** カスタムプロバイダーの更新。provider id は変更できず、apiKey の空欄（未送信）は既存を維持する */
export const putCustomProvider = (provider: string, input: UpdateCustomProviderBody) =>
  read<ModelMutationResponse>(
    client.api.settings["custom-providers"][":provider"].$put({ param: { provider }, json: input }),
  );

/** カスタムプロバイダーの削除。アプリ DB の行を消してから、実行中のランタイムの定義とキーを外す */
export const deleteCustomProvider = (provider: string) =>
  read<ModelMutationResponse>(client.api.settings["custom-providers"][":provider"].$delete({ param: { provider } }));

/**
 * カスタムプロバイダーの `/models` を取得する。接続できない場合も 200 の分類で返るため、
 * ここが失敗するのは body 不正 (400) だけ。`settings` は変えない。
 */
export const probeCustomProvider = (input: CustomProviderProbeBody) =>
  read<CustomProviderProbeResponse>(client.api.settings["custom-providers"].probe.$post({ json: input }));

/** degraded（保存済み・未反映）の回復。DB の希望状態を SDK へ再適用するだけで、冪等 */
export const resyncProviderApiKey = (provider: string) =>
  read<ModelMutationResponse>(client.api.settings.models[":provider"].resync.$post({ param: { provider } }));

/**
 * OAuth サインインの開始。応答は GET と同じ形で、進行中の認可 URL は provider.login にだけ載る。
 * アプリ DB は変わらないため `state` は無い。進行中の二重開始は 409。
 */
export const startOAuthLogin = (provider: string) =>
  read<ModelsSettingsResponse>(client.api.settings.models[":provider"].login.$post({ param: { provider } }));

/** ブラウザの最後に表示されたリダイレクト先 URL / コードを、待機中の SDK へ渡す */
export const submitOAuthLoginCode = (provider: string, code: string) =>
  read<ModelsSettingsResponse>(
    client.api.settings.models[":provider"].login.code.$post({
      param: { provider },
      json: { code },
    }),
  );

/** 進行中の select prompt に、選んだ選択肢 id を返す */
export const selectOAuthLoginMethod = (provider: string, id: string) =>
  read<ModelsSettingsResponse>(
    client.api.settings.models[":provider"].login.select.$post({
      param: { provider },
      json: { id },
    }),
  );

/** 進行中のサインインの中断と、終端した結果表示の消去（どちらも冪等） */
export const cancelOAuthLogin = (provider: string) =>
  read<ModelsSettingsResponse>(client.api.settings.models[":provider"].login.$delete({ param: { provider } }));

/** サインアウト。auth.json の OAuth を削除するだけで、この画面で登録したキーは残す */
export const logoutOAuthProvider = (provider: string) =>
  read<ModelsSettingsResponse>(client.api.settings.models[":provider"].logout.$post({ param: { provider } }));

/**
 * 設定 → コンテンツ生成の設定（純粋読取）。APIキーは含まれず、登録済みでも値は返らない。
 * 画像モデルの選択肢は `image.models` で、キー未設定なら configured: false。
 */
export const getContentSettings = async (): Promise<ContentSettingsResponse> => {
  const res = await ensureOk(client.api.settings.content.$get());
  return res.json();
};

/**
 * 有効 / 無効（画像・音声・BGM 共通の 1 つのトグル）。キーと選択は保持され、行が無ければ 400。
 * 保存した瞬間から、既存のセッションにも次の呼び出しから効く。
 */
export const putContentEnabled = async (enabled: boolean): Promise<ContentMutationResponse> => {
  const res = await ensureOk(client.api.settings.content.$put({ json: { enabled } }));
  return res.json();
};

/** 画像モデルの変更。キーは保持され、行が無ければ 400 */
export const putContentImageSettings = (input: UpdateContentImageBody) =>
  read<ContentMutationResponse>(client.api.settings.content.image.$put({ json: input }));

/**
 * 画像の生成元（openrouter / codex）の変更。キーもモデルも伴わず、行が無くても受け付ける
 * （Codex はAPIキーを使わない）。切り替えても他方の設定は消えない。
 */
export const putContentImageProvider = (input: UpdateContentImageProviderBody) =>
  read<ContentMutationResponse>(client.api.settings.content.image.provider.$put({ json: input }));

/**
 * 音声モデル / ボイスの変更。キーと画像モデルは保持され、行が無ければ 400。
 * `voice` の空文字は「指定なし」（宣言が無いモデルで送らない）を表す。
 */
export const putContentSpeechSettings = (input: UpdateContentSpeechBody) =>
  read<ContentMutationResponse>(client.api.settings.content.speech.$put({ json: input }));

/** コンテンツ生成（画像 / 音声）のAPIキーの登録・上書き。行が無ければ既定 provider / model で作成される */
export const putContentApiKey = (apiKey: string) =>
  read<ContentMutationResponse>(client.api.settings.content.key.$put({ json: { apiKey } }));

/**
 * 試行ジョブの開始。応答は 202（開始）か 200（同じ入力の保存済み結果を再利用。課金しない）で、
 * 状態は `getContentTrial` / `listContentTrials` で取る。
 * リクエストの signal には結び付けない（画面を離れても続き、中断はキャンセル API だけが行う）。
 */
export const startContentTrial = (input: CreateContentTrialBody) =>
  read<ContentTrialStartResponse>(client.api.settings.content.trials.$post({ json: input }));

/**
 * 試行の開始の拒否の分類。空き不足だけを他と分ける（行も課金も作らない拒否で、`storage` の
 * 終端失敗とは意味が違う）。コードの値はサーバーの定数が正で、ここは写しを持つだけ。
 */
export function contentTrialStartFailure(error: unknown): "disk_shortage" | "other" {
  return error instanceof ApiError && error.code === "disk_shortage" ? "disk_shortage" : "other";
}

/**
 * 試行の一覧（新しい順）。`kind` を省くと全種別。`limit` / `before` でページを進め、`state: "running"` は
 * 実行中の行だけを取る（実行中のポーリングを履歴の件数に比例させない）。
 * 取得のたびにサーバーが running の再照合をする。
 */
export interface ContentTrialsQuery {
  kind?: string;
  limit?: number;
  /** 前のページの `nextBefore`。不透明なので組み立てない */
  before?: string;
  /** 実行中の行だけを取る */
  state?: "running";
}

export const listContentTrials = (query: ContentTrialsQuery = {}) => {
  const search: Record<string, string> = {};
  if (query.kind !== undefined) search.kind = query.kind;
  if (query.limit !== undefined) search.limit = String(query.limit);
  if (query.before !== undefined) search.before = query.before;
  if (query.state !== undefined) search.state = query.state;
  return read<ContentTrialListResponse>(client.api.settings.content.trials.$get({ query: search }));
};

/**
 * 試行 1 件の取得の失敗が「その行が無い」を表すか。**404 だけを消失とし**、通信断（status 0）や 5xx は
 * 不明として区別する（ポーリング中に 1 回失敗しただけで実行中の行を一覧から消さないため）。
 */
export function isMissingContentTrial(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** 試行 1 件。終端を記録できていない間は `recorded: false` でメモリの状態が返る */
export const getContentTrial = (id: string) =>
  read<ContentTrialResponse>(client.api.settings.content.trials[":id"].$get({ param: { id } }));

/** キャンセル。`running` のときだけ受け付け、終端は 409（状態を戻さない） */
export const cancelContentTrial = (id: string) =>
  read<ContentTrialResponse>(client.api.settings.content.trials[":id"].cancel.$post({ param: { id } }));

/** 個別削除。終端状態だけで、`running` は 409（先に中断する） */
export const deleteContentTrial = (id: string) =>
  read<ContentTrialDeleteResponse>(client.api.settings.content.trials[":id"].$delete({ param: { id } }));

/** すべて削除。終端状態だけが対象で、実行中の試行は残る */
export const deleteAllContentTrials = (kind?: string) =>
  read<ContentTrialDeleteResponse>(
    client.api.settings.content.trials.$delete(kind === undefined ? {} : { query: { kind } }),
  );

/** 画像のAPIキーの削除（行ごと消して未設定へ戻す）。未設定でも 200 の冪等 */
export const deleteContentApiKey = () => read<ContentMutationResponse>(client.api.settings.content.key.$delete());

/**
 * 設定 → 共有 → 接続 の Cloudflare 資格情報。GET は登録状態とアカウント ID だけで、
 * API トークンは返らない。PUT の `apiToken` を省略すると保存済みトークンを維持する。
 */
export const getCloudflareSettings = async (): Promise<CloudflareSettingsResponse> => {
  const res = await ensureOk(client.api.settings.cloudflare.$get());
  return res.json();
};

export const updateCloudflareSettings = async (
  input: UpdateCloudflareSettingsBody,
): Promise<CloudflareMutationResponse> => {
  const res = await ensureOk(client.api.settings.cloudflare.$put({ json: input }));
  return res.json();
};

export const deleteCloudflareSettings = async (): Promise<CloudflareMutationResponse> => {
  const res = await ensureOk(client.api.settings.cloudflare.$delete());
  return res.json();
};

/**
 * 保存済みの資格情報で Cloudflare へ届くかを確認する。何も保存せず、Cloudflare 側の失敗も 200 の
 * 結果として返る。未登録（409）と master key 不在・復号不可（503）だけが失敗になる。
 */
export const checkCloudflareConnection = async (): Promise<CloudflareConnectionCheckResponse> => {
  const res = await ensureOk(client.api.settings.cloudflare.check.$post());
  return res.json();
};

/**
 * 設定 → Web 検索。有効 / 無効の 1 つだけを返し、無効時にモデルへ返る固定文言も載せる。
 * 正はアプリ DB の `web_search_settings` で、行が無い = 既定（無効）。
 */
export const getWebSearchSettings = async (): Promise<WebSearchSettingsResponse> => {
  const res = await ensureOk(client.api.settings["web-search"].$get());
  return res.json();
};

/** Web 検索の有効 / 無効。保存した瞬間から、既存のセッションの次の呼び出しにも効く */
export const putWebSearchSettings = (enabled: boolean) =>
  read<WebSearchMutationResponse>(client.api.settings["web-search"].$put({ json: { enabled } }));

/** 既定の検索プロバイダー。選んだ時点で保存され、次の検索から使われる */
export const putWebSearchProvider = (provider: WebSearchProviderId) =>
  read<WebSearchMutationResponse>(client.api.settings["web-search"].provider.$put({ json: { provider } }));

/** provider の APIキーの登録・上書き。値は応答へ返らず、画面は設定済みかだけを受け取る */
export const putWebSearchApiKey = (provider: WebSearchProviderId, apiKey: string) =>
  read<WebSearchMutationResponse>(
    client.api.settings["web-search"].providers[":provider"].key.$put({
      param: { provider },
      json: { apiKey },
    }),
  );

/**
 * 設定 → Web 検索のテスト検索。保存済みの設定で 1 回だけ検索し、モデルへ返る本文をそのまま返す。
 * 検索の失敗も 200 の `ok: false` で返る（会話にも設定にも残らない）。
 */
export const postWebSearchTest = async (query: string): Promise<WebSearchTestResponse> => {
  const res = await ensureOk(client.api.settings["web-search"].test.$post({ json: { query } }));
  return res.json();
};

/** provider の APIキーの削除（行ごと消して未設定へ戻す）。未設定でも 200 の冪等 */
export const deleteWebSearchApiKey = (provider: WebSearchProviderId) =>
  read<WebSearchMutationResponse>(
    client.api.settings["web-search"].providers[":provider"].key.$delete({
      param: { provider },
    }),
  );

/**
 * 設定 → 音声入力。保存済みのキーの状態（有無 / 復号できたか）と固定モデルを読む。
 * キーの値は返らず、GET は復号もしない。
 */
export const getVoiceInputSettings = async (): Promise<VoiceInputSettingsResponse> => {
  const res = await ensureOk(client.api.settings["voice-input"].$get());
  return res.json();
};

/** 音声入力のAPIキーの登録・上書き。応答にキーは返らない */
export const putVoiceInputKey = (apiKey: string) =>
  read<VoiceInputMutationResponse>(client.api.settings["voice-input"].key.$put({ json: { apiKey } }));

/** 音声入力のAPIキーの削除（行ごと消して未設定へ戻す）。未設定でも 200 の冪等 */
export const deleteVoiceInputKey = () =>
  read<VoiceInputMutationResponse>(client.api.settings["voice-input"].key.$delete());

/**
 * 音声入力の疎通確認。短命キーの発行だけを呼び、音声は送らない（課金なし）。
 * 上流の確認失敗は 200 の `ok: false` で返り、未登録 / 利用不可は HTTP エラーになる。
 */
export const postVoiceInputTest = async (): Promise<VoiceInputTestResponse> => {
  const res = await ensureOk(client.api.settings["voice-input"].test.$post());
  return res.json();
};

/**
 * 音声入力の Realtime セッション開始。offer SDP を BFF へ中継し、answer SDP を受け取る。
 * 本文は SDP を raw で送るため `hc` を使わず fetch を使う（BFF は `application/sdp` だけを受ける）。
 * 失敗は JSON の `error` / `code`（402 の残高不足など）を持つ ApiError になる。
 */
export const postVoiceInputSession = async (offerSdp: string, signal: AbortSignal): Promise<string> => {
  const res = await ensureOk(
    fetch(client.api["voice-input"].session.$url(), {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: offerSdp,
      signal,
    }),
  );
  return res.text();
};

/** 設定 → Git。グローバルな identity（user.name / user.email）を読む。未設定は両方 null */
export const getGitSettings = async (): Promise<GitSettingsResponse> => {
  const res = await ensureOk(client.api.settings.git.$get());
  return res.json();
};

/** 両方必須。片方だけの保存はサーバーが 400 で拒否する */
export const putGitSettings = async (userName: string, userEmail: string): Promise<GitSettingsMutationResponse> => {
  const res = await ensureOk(client.api.settings.git.$put({ json: { userName, userEmail } }));
  return res.json();
};

/** 未設定へ戻す（冪等）。次の bash から useConfigOnly だけの config になる */
export const deleteGitSettings = async (): Promise<GitSettingsMutationResponse> => {
  const res = await ensureOk(client.api.settings.git.$delete());
  return res.json();
};

/**
 * 設定 → 会話タイトル。AI 要約の On/Off・要約モデル・定義を持つ。行が無い = 既定 (Off) で、
 * 本会話のモデルとは独立している。
 */
export const getTitleSummarySettings = async (): Promise<TitleSummarySettingsResponse> => {
  const res = await ensureOk(client.api.settings["session-title"].$get());
  return res.json();
};

/** 3 項目の保存。省略した項目はサーバーが保存値を保つ (Off への変更でもモデルを消さない) */
export const putTitleSummarySettings = async (body: UpdateTitleSummaryBody): Promise<TitleSummarySettingsResponse> => {
  const res = await ensureOk(client.api.settings["session-title"].$put({ json: body }));
  return res.json();
};

/** 保存済みの設定で 1 回だけ生成する。タイトルは保存しない。生成の失敗も 200 の `ok: false` で返る */
export const postTitleSummaryTest = async (): Promise<TitleSummaryTestResponse> => {
  const res = await ensureOk(client.api.settings["session-title"].test.$post());
  return res.json();
};

/** コストマスタの接続先とトグル。保存時に取得しない（価格は [カタログ更新] で取る） */
export const putContentCost = (input: UpdateContentCostBody) =>
  read<ContentMutationResponse>(client.api.settings.content["cost-url"].$put({ json: input }));

/**
 * モデル一覧と価格の再取得。取得できなくても 200 で、失敗は系統ごとの `errors` にだけ載る
 * （一覧も価格も手元に残る）。応答は GET と同じ形なので、そのまま次の状態にできる。
 */
export const refreshContentCatalog = () =>
  read<ContentCatalogRefreshResponse>(client.api.settings.content.catalog.refresh.$post());

/**
 * 設定 → バックアップ。書き出しの見積りは `targets` で絞れる (省略は全部)。
 * 復元の plan / apply は raw の ZIP を送るため `hc` を使わず、同じ `File` を 2 回送る。
 */
const backupQuery = (targets: readonly BackupTarget[], extra: Record<string, string> = {}): URLSearchParams => {
  const params = new URLSearchParams(extra);
  for (const target of targets) params.append("targets", target);
  return params;
};

/** raw body の経路は `hc` を使わないため、同一オリジンの絶対 URL をここで組み立てる */
const backupUrl = (path: string, params: URLSearchParams): string => `${location.origin}${path}?${params.toString()}`;

export const getBackupExportCheck = (targets: readonly BackupTarget[] = ALL_BACKUP_TARGETS) =>
  read<BackupExportCheck>(fetch(backupUrl("/api/backup/export/check", backupQuery(targets))));

/** 書き出しの URL (`<a download>` の href)。保存名は応答の `Content-Disposition` が決める */
export const backupExportUrl = (targets: readonly BackupTarget[] = ALL_BACKUP_TARGETS): string =>
  backupUrl("/api/backup/export", backupQuery(targets));

/**
 * 復元の plan。何も変更せず、現在との差分・削除対象・警告・ブロッカーを返す。
 * `targets` を省略するとサーバーが manifest の全対象を使う (一部の対象だけの ZIP でも 400 にしない)。
 */
export const planBackupRestore = (file: File, targets?: readonly BackupTarget[]) =>
  read<BackupRestorePlan>(
    fetch(backupUrl("/api/backup/restore", backupQuery(targets ?? [], { dryRun: "true" })), {
      method: "POST",
      body: file,
    }),
  );

/** 復元の適用。plan と同じ `File` を送り、サーバーがその時点の状態で再判定する */
export const applyBackupRestore = (file: File, targets: readonly BackupTarget[]) =>
  read<BackupRestoreResult>(
    fetch(backupUrl("/api/backup/restore", backupQuery(targets)), {
      method: "POST",
      body: file,
    }),
  );

/** ユーザー定義エージェント / 自作プロンプト / 共通スキルの全削除 */
export const resetDefinitions = () => read<BackupResetResult>(client.api.backup.reset.$post());
