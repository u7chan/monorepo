import { hc } from "hono/client";
import type { AppType } from "server";
import { encodeFilePathParam } from "./lib/fileUrl";
import type {
  AgentDef,
  ArchiveSettingsResponse,
  AskUserAnswer,
  CatalogResponse,
  ContentMutationResponse,
  ContentSettingsResponse,
  CreateAgentBody,
  CreateSkillBody,
  DiscardUnsentResult,
  FileDownloadCheck,
  FileListing,
  FilePreview,
  FileRename,
  FileSkillsResponse,
  GitInfo,
  Health,
  HistoryPage,
  ImageCatalogRefreshResponse,
  ModelCatalogRefreshResponse,
  ModelMutationResponse,
  ModelRef,
  ModelsSettingsResponse,
  NotificationResult,
  NotificationsResponse,
  PostMessageResult,
  Project,
  ProjectsResponse,
  RuntimeEnvironmentResponse,
  RuntimeModelsResponse,
  RuntimeServeStatus,
  SecretDetailResponse,
  SecretKind,
  SecretMutationResponse,
  SecretRemovalResponse,
  SecretsListResponse,
  ServeStatus,
  SessionCompactionResult,
  SessionNotifyResponse,
  SessionPinnedResponse,
  SessionPayload,
  SessionSkillsPreview,
  SessionSkillsResponse,
  SessionSummary,
  SessionTitleResponse,
  SkillDef,
  SpeechCatalogRefreshResponse,
  StopResult,
  ThinkingLevel,
  UpdateAgentBody,
  UpdateContentImageBody,
  UpdateContentSpeechBody,
  UpdateModelAvailabilityBody,
  UpdateNotificationsBody,
  UpdateSkillBody,
  WebSearchMutationResponse,
  WebSearchProviderId,
  WebSearchSettingsResponse,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** 変更系の 503 だけが持つ。何も保存されていないことを UI が区別できる */
    public readonly state?: "not_stored",
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 変更系の 503 だけが返す `state: "not_stored"`。何も保存されていないことを UI が区別できる */
export function isNotStoredError(error: unknown): boolean {
  return error instanceof ApiError && error.state === "not_stored";
}

// Vite dev は /api を 4317 へプロキシするため同一オリジンで扱える
const client = hc<AppType>(location.origin);

export function createSpaceApi(spaceId: string) {
  const scope = (url: URL): URL => {
    url.searchParams.set("spaceId", spaceId);
    return url;
  };
  const scoped = hc<AppType>(location.origin, {
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      fetch(scope(new URL(input instanceof Request ? input.url : String(input), location.origin)), init),
  });
  const read = async <T>(response: Promise<Response>): Promise<T> => {
    const res = await response;
    if (!res.ok) throw await apiError(res);
    return res.json() as Promise<T>;
  };
  const session = scoped.api.sessions[":id"];
  return {
    listSessions: () => read<{ sessions: SessionSummary[] }>(scoped.api.sessions.$get()),
    createSession: (agentId?: string, overrides: CreateSessionOverrides = {}) =>
      read<SessionPayload>(scoped.api.sessions.$post({ json: { ...overrides, agentId, spaceId } })),
    getSession: (id: string) => read<SessionPayload>(session.$get({ param: { id } })),
    getSessionHistory: (id: string, options: { before?: string | null; limit?: number } = {}) => {
      const url = scope(session.history.$url({ param: { id } }));
      if (options.before) url.searchParams.set("before", options.before);
      if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
      return read<HistoryPage>(fetch(url));
    },
    deleteSession: (id: string) => read<unknown>(session.$delete({ param: { id } })),
    updateSessionSettings: (id: string, json: SessionOverrides) =>
      read<SessionPayload>(session.settings.$patch({ param: { id }, json })),
    updateSessionNotify: (id: string, notify: boolean) =>
      read<SessionNotifyResponse>(session.notify.$patch({ param: { id }, json: { notify } })),
    updateSessionPinned: (id: string, pinned: boolean) =>
      read<SessionPinnedResponse>(session.pin.$patch({ param: { id }, json: { pinned } })),
    updateSessionTitle: (id: string, title: string) =>
      read<SessionTitleResponse>(session.title.$patch({ param: { id }, json: { title } })),
    stopSession: (id: string) => read<StopResult>(session.stop.$post({ param: { id } })),
    compactSession: (id: string) => read<SessionCompactionResult>(session.compact.$post({ param: { id } })),
    postMessage: (id: string, text: string, attachments: string[] = []) =>
      read<PostMessageResult>(session.messages.$post({ param: { id }, json: { text, attachments } })),
    resendMessage: (id: string, runId: string) =>
      read<PostMessageResult>(session.messages.$post({ param: { id }, json: { resendRunId: runId } })),
    discardUnsentMessage: (id: string, runId: string) =>
      read<DiscardUnsentResult>(session.unsent[":runId"].$delete({ param: { id, runId } })),
    answerQuestion: (id: string, toolCallId: string, answers: AskUserAnswer[]) =>
      read<{ ok: true }>(
        session.questions[":toolCallId"].answer.$post({ param: { id, toolCallId }, json: { answers } }),
      ),
    uploadSessionFile: (id: string, file: File) =>
      read<SessionFileUpload>(
        fetch(scope(session.files.$url({ param: { id }, query: { name: file.name } })), {
          method: "POST",
          body: file,
        }),
      ),
    getSessionSkills: (id: string) => read<SessionSkillsResponse>(session.skills.$get({ param: { id } })),
    getSessionSkillsPreview: (input: { projectId: string; agentId: string }) =>
      read<SessionSkillsPreview>(
        scoped.api.skills.session.$get({
          query: {
            ...(input.projectId ? { projectId: input.projectId } : {}),
            ...(input.agentId ? { agentId: input.agentId } : {}),
          },
        }),
      ),
    listProjects: () => read<ProjectsResponse>(scoped.api.projects.$get()),
    createProject: (json: CreateProjectInput) => read<{ project: Project }>(scoped.api.projects.$post({ json })),
    deleteProject: (id: string) => read<unknown>(scoped.api.projects[":id"].$delete({ param: { id } })),
    getServeStatus: (sessionId: string, signal?: AbortSignal) =>
      read<ServeStatus>(scoped.api.serve.status.$get({ query: { sessionId } }, { init: { signal } })),
    startServe: (json: { sessionId: string; generation: string | null }, signal?: AbortSignal) =>
      read<ServeStatus>(scoped.api.serve.start.$post({ json }, { init: { signal } })),
    stopServe: (json: { sessionId: string; generation: string | null }) =>
      read<ServeStatus>(scoped.api.serve.stop.$post({ json })),
    getSecrets: (input: SecretsScope, signal?: AbortSignal) =>
      read<SecretsListResponse>(scoped.api.secrets.$get({ query: scopeQuery(input) }, { init: { signal } })),
    getSecretDetail: (input: SecretsScope, secretId: string, signal?: AbortSignal) =>
      read<SecretDetailResponse>(fetch(scope(detailUrl(input, secretId)), { signal })),
    createSecret: (json: SecretsScope & { kind: SecretKind; name: string; value: string }) =>
      read<SecretMutationResponse>(scoped.api.secrets.$post({ json })),
    updateSecret: (input: SecretsScope, secretId: string, value: string) =>
      read<SecretMutationResponse>(
        scoped.api.secrets[":secretId"].$put({ param: { secretId }, json: { ...scopeQuery(input), value } }),
      ),
    deleteSecret: (input: SecretsScope, secretId: string) =>
      read<SecretRemovalResponse>(fetch(scope(detailUrl(input, secretId)), { method: "DELETE" })),
  };
}

export const listSpaces = async (): Promise<{ spaces: import("server").Space[] }> => {
  const res = await client.api.spaces.$get();
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export const createSpace = async (name: string): Promise<{ space: import("server").Space }> => {
  const res = await client.api.spaces.$post({ json: { name } });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

async function apiError(res: Response): Promise<ApiError> {
  const body: unknown = await res.json().catch(() => null);
  const message =
    typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : `HTTP ${res.status}`;
  const state =
    typeof body === "object" && body !== null && "state" in body && body.state === "not_stored"
      ? ("not_stored" as const)
      : undefined;
  return new ApiError(message, res.status, state);
}

export const getHealth = async (): Promise<Health> => {
  const res = await client.api.health.$get();
  // throw で制御フローを切ると res.json() が成功型になる
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export const getRuntimeModels = async (): Promise<RuntimeModelsResponse> => {
  const res = await client.api.runtime.models.$get();
  if (!res.ok) throw await apiError(res);
  return res.json();
};

/**
 * 実行環境の診断。未接続を含む 6 状態を HTTP 200 で返すため、ここでの失敗は BFF 自体の異常を表す。
 * UI は HTTP ステータスではなく応答の `state` で分岐する。
 */
export const getRuntimeEnvironment = async (): Promise<RuntimeEnvironmentResponse> => {
  const res = await client.api.runtime.environment.$get();
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export const getCatalog = async (): Promise<CatalogResponse> => {
  const res = await client.api.agents.$get();
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export const createAgent = async (input: CreateAgentBody): Promise<{ agent: AgentDef }> => {
  const res = await client.api.agents.$post({ json: input });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export const updateAgent = async (id: string, input: UpdateAgentBody): Promise<{ agent: AgentDef }> => {
  const res = await client.api.agents[":id"].$patch({ param: { id }, json: input });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export const deleteAgent = async (id: string): Promise<unknown> => {
  const res = await client.api.agents[":id"].$delete({ param: { id } });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export const createSkill = async (input: CreateSkillBody): Promise<{ skill: SkillDef }> => {
  const res = await client.api.skills.$post({ json: input });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export const updateSkill = async (id: string, input: UpdateSkillBody): Promise<{ skill: SkillDef }> => {
  const res = await client.api.skills[":id"].$patch({ param: { id }, json: input });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export const deleteSkill = async (id: string): Promise<unknown> => {
  const res = await client.api.skills[":id"].$delete({ param: { id } });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

/**
 * 共通スキル (`.agents/skills`) の読み取り専用一覧。catalog のスキル定義とは別で、編集できない。
 * サンドボックス未設定は 503、サンドボックス側の失敗は 502 で reject する。
 */
export const getFileSkills = async (): Promise<FileSkillsResponse> => {
  const res = await client.api.skills.files.$get();
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as FileSkillsResponse;
};

// 並び順と件数上限はサーバーが決めるため、クライアントでは再ソートしない
export const getFiles = async (path = "."): Promise<FileListing> => {
  const res = await client.api.files.$get({ query: { path } });
  if (!res.ok) throw await apiError(res);
  // 400 (root 外) / 503 (未設定) の応答型が残るため、!ok を throw で切った後に DTO 型へ寄せる
  return (await res.json()) as FileListing;
};

/**
 * 作業フォルダ (root 相対) が属する repo のブランチ。repo の外・git が無い環境は null で、
 * 表示側はチップを出さないだけにする (一覧の表示を止めない)。
 */
export const getGitInfo = async (path = "."): Promise<GitInfo> => {
  const res = await client.api.files.git.$get({ query: { path } });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as GitInfo;
};

/**
 * ファイルの削除。成功は 204 で本文が無いため JSON は読まない。パスは GET /api/files と同じ root 相対で、
 * 検証 (root 外 / 不存在 / symlink / ディレクトリ) はサンドボックスに委ねる。
 */
export const deleteFile = async (path: string): Promise<void> => {
  const res = await client.api.files.$delete({ query: { path } });
  if (!res.ok) throw await apiError(res);
};

/**
 * ディレクトリの削除。配下ごと消す `recursive=true` を明示して呼ぶ (空ディレクトリも同じ経路)。
 * 成功は 204 で本文が無いため JSON は読まない。検証 (root 外 / 不存在 / ディレクトリ以外 / symlink) はサンドボックスに委ねる。
 */
export const deleteDirectory = async (path: string): Promise<void> => {
  const res = await client.api.files.$delete({ query: { path, recursive: "true" } });
  if (!res.ok) throw await apiError(res);
};

/**
 * エントリ (ファイル / ディレクトリ) のリネーム。`path` は GET /api/files と同じ root 相対で、`name` は 1 セグメントの新しい名前。
 * 検証 (root 外 / 不存在 / 形式 / symlink / 同名 409) はサンドボックスに委ね、応答は改名後の root 相対パス。
 */
export const renameEntry = async (path: string, name: string): Promise<FileRename> => {
  const res = await client.api.files.rename.$post({ json: { path, name } });
  if (!res.ok) throw await apiError(res);
  // 400 / 404 / 409 / 503 の応答型が残るため、!ok を throw で切った後に DTO 型へ寄せる
  return (await res.json()) as FileRename;
};

export const getFilePreview = async (path: string, signal: AbortSignal): Promise<FilePreview> => {
  const res = await client.api.files.preview.$get({ query: { path } }, { init: { signal } });
  if (!res.ok) throw await apiError(res);
  // 400 (root 外 / バイナリ等) / 503 (未設定) の応答型が残るため、!ok を throw で切った後に DTO 型へ寄せる
  return (await res.json()) as FilePreview;
};

/**
 * HTML プレビュー (iframe の src)。取得は iframe に任せるので、ここでは URL だけを組み立てる。
 * 同じルートが文書の相対アセット (画像 / `.js` など) も配信するため、path はセグメント単位で encode してパス形式の URL を組み立てる。
 */
export const fileHtmlPreviewUrl = (path: string): string =>
  client.api.files.html[":path{.+}"].$url({ param: { path: encodeFilePathParam(path) } }).toString();

/**
 * ストレージ有効モードの HTML プレビュー URL (別オリジンの iframe の src)。ポートは health から受ける
 * (client に焼き込まない)。location.host ではなく hostname + port を組むのは、dev でアプリが Vite の
 * 3000 に居り BFF が別ポートのため (相対ルートはアプリ オリジンに解決されてしまう)。
 */
export const fileStoragePreviewUrl = (path: string, filePreviewPort: number): string =>
  `http://${location.hostname}:${filePreviewPort}/api/files/html/${encodeFilePathParam(path)}`;

/**
 * 画像プレビュー用の raw URL。path はワークスペース root 相対で、配信できるのは allowlist の画像だけ。
 * 生配信に載せるため bodyGuard の上限を通らず、Content-Type はサーバーが決める。
 */
export const fileRawUrl = (path: string, version?: number): string => {
  const url = client.api.files.raw.$url({ query: { path } });
  if (version !== undefined) url.searchParams.set("v", String(version));
  return url.toString();
};

/**
 * ダウンロードの事前チェック。download と同じ走査の見積り（種別 / 保存名 / 除外名 / 合計サイズ / 件数）を返し、
 * 除外名のディレクトリ・上限超過は 400 / 413 で reject する（UI はツリーの行に理由を出す）。
 */
export const getFileDownloadCheck = async (path: string): Promise<FileDownloadCheck> => {
  const res = await client.api.files.download.check.$get({ query: { path } });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as FileDownloadCheck;
};

/**
 * ダウンロードの URL（`<a download>` の href）。ファイルは生配信、ディレクトリは ZIP になり、
 * 保存名は応答の `Content-Disposition` が決める。本文は fetch せずブラウザに任せる（100 MiB を保持しない）。
 */
export const fileDownloadUrl = (path: string): string => client.api.files.download.$url({ query: { path } }).toString();

export type CreateProjectInput = {
  cwd: string;
  name?: string;
  create?: boolean;
};

export type SessionOverrides = {
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
};

export type CreateSessionOverrides = SessionOverrides & { projectId?: string; notify?: boolean };

export type SessionFileUpload = {
  sessionId: string;
  /** root 相対の保存パス。通常 / 追加スペースの添付置き場をそのまま raw URL に使える */
  path: string;
  name: string;
  renamed: boolean;
  size: number;
};

/**
 * 通知設定。Webhook URL は write-only で、応答には `configured` と末尾 4 文字しか載らない。
 * テスト送信は保存済み設定で 1 通送り、Discord 側の失敗も結果 (ok: false) として 200 で返る。
 */
export const getNotifications = async (): Promise<NotificationsResponse> => {
  const res = await client.api.notifications.$get();
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export const updateNotifications = async (input: UpdateNotificationsBody): Promise<NotificationsResponse> => {
  const res = await client.api.notifications.$put({ json: input });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export const testNotification = async (): Promise<NotificationResult> => {
  const res = await client.api.notifications.test.$post();
  if (!res.ok) throw await apiError(res);
  return res.json();
};

/**
 * アーカイブの除外名。`excludeNames` は常に実効値で、`overridden` が false のときは既定の一覧を使っている。
 * 保存（PUT）と既定に戻す（DELETE）も同じ形を返すため、画面は応答をそのまま次の状態にできる。
 */
export const getArchiveSettings = async (): Promise<ArchiveSettingsResponse> => {
  const res = await client.api.settings.archive.$get();
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export const updateArchiveSettings = async (excludeNames: string[]): Promise<ArchiveSettingsResponse> => {
  const res = await client.api.settings.archive.$put({ json: { excludeNames } });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

/** 保存行を消して未設定へ戻す（既定名を保存し直さないので、将来の既定の追加に追随する） */
export const resetArchiveSettings = async (): Promise<ArchiveSettingsResponse> => {
  const res = await client.api.settings.archive.$delete();
  if (!res.ok) throw await apiError(res);
  return res.json();
};

/**
 * 設定 → モデルのプロバイダー認証状態（純粋読取）。キー値は含まれない。
 * モデル数と一覧は別途 `getRuntimeModels()` が持ち、片方の失敗が他方を隠さない。
 */
export const getModelsSettings = async (): Promise<ModelsSettingsResponse> => {
  const res = await client.api.settings.models.$get();
  if (!res.ok) throw await apiError(res);
  return res.json();
};

/**
 * pi.dev のモデルカタログを取り直す。取得できなくても 200 で、失敗は `catalogError` にだけ載る
 * （一覧は手元に残る）。設定は変わらないため、応答は `GET /api/runtime/models` と同じ形 + この 1 フィールド。
 */
export const refreshModelCatalog = async (): Promise<ModelCatalogRefreshResponse> => {
  const res = await client.api.settings.models.catalog.refresh.$post();
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as ModelCatalogRefreshResponse;
};

/**
 * 利用可能なモデルとアプリ既定モデルの一括保存。両方 null は「未設定へ戻す」。
 * SDK 呼び出しを含まないため `applied_unsynced` にはならない。
 */
export const putModelAvailability = async (input: UpdateModelAvailabilityBody): Promise<ModelMutationResponse> => {
  const res = await client.api.settings.models.allowed.$put({ json: input });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as ModelMutationResponse;
};

/** APIキーの登録（既存は上書き）。保存は確定し、SDK へ未反映なら `state: "applied_unsynced"` で返る */
export const putProviderApiKey = async (provider: string, apiKey: string): Promise<ModelMutationResponse> => {
  const res = await client.api.settings.models[":provider"].key.$put({ param: { provider }, json: { apiKey } });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as ModelMutationResponse;
};

/** この画面で登録したキーの削除。この画面の管理外（行が無い）は 400 */
export const deleteProviderApiKey = async (provider: string): Promise<ModelMutationResponse> => {
  const res = await client.api.settings.models[":provider"].key.$delete({ param: { provider } });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as ModelMutationResponse;
};

/**
 * provider のメモ（人間用の任意文字列）。SDK に触れないため常に `state: "applied"`。
 * 空文字を送ると行が消えて `memo: null` に戻る。
 */
export const putProviderMemo = async (provider: string, memo: string): Promise<ModelMutationResponse> => {
  const res = await client.api.settings.models[":provider"].memo.$put({ param: { provider }, json: { memo } });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as ModelMutationResponse;
};

/** degraded（保存済み・未反映）の回復。DB の希望状態を SDK へ再適用するだけで、冪等 */
export const resyncProviderApiKey = async (provider: string): Promise<ModelMutationResponse> => {
  const res = await client.api.settings.models[":provider"].resync.$post({ param: { provider } });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as ModelMutationResponse;
};

/**
 * 設定 → モデルのコンテンツ生成タブ（純粋読取）。APIキーは含まれず、登録済みでも値は返らない。
 * 画像モデルの選択肢は `image.models` で、キー未設定なら configured: false。
 */
export const getContentSettings = async (): Promise<ContentSettingsResponse> => {
  const res = await client.api.settings.content.$get();
  if (!res.ok) throw await apiError(res);
  return res.json();
};

/** 画像モデルの変更。キーは保持され、行が無ければ 400 */
export const putContentImageSettings = async (input: UpdateContentImageBody): Promise<ContentMutationResponse> => {
  const res = await client.api.settings.content.image.$put({ json: input });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as ContentMutationResponse;
};

/**
 * 音声モデル / ボイスの変更。キーと画像モデルは保持され、行が無ければ 400。
 * `voice` の空文字は「指定なし」（宣言が無いモデルで送らない）を表す。
 */
export const putContentSpeechSettings = async (input: UpdateContentSpeechBody): Promise<ContentMutationResponse> => {
  const res = await client.api.settings.content.speech.$put({ json: input });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as ContentMutationResponse;
};

/** コンテンツ生成（画像 / 音声）のAPIキーの登録・上書き。行が無ければ既定 provider / model で作成される */
export const putContentApiKey = async (apiKey: string): Promise<ContentMutationResponse> => {
  const res = await client.api.settings.content.key.$put({ json: { apiKey } });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as ContentMutationResponse;
};

/** 画像のAPIキーの削除（行ごと消して未設定へ戻す）。未設定でも 200 の冪等 */
export const deleteContentApiKey = async (): Promise<ContentMutationResponse> => {
  const res = await client.api.settings.content.key.$delete();
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as ContentMutationResponse;
};

/**
 * 設定 → モデル（Web 検索タブ）。有効 / 無効の 1 つだけを返し、無効時にモデルへ返る固定文言も載せる。
 * 正はアプリ DB の `web_search_settings` で、行が無い = 既定（有効）。
 */
export const getWebSearchSettings = async (): Promise<WebSearchSettingsResponse> => {
  const res = await client.api.settings["web-search"].$get();
  if (!res.ok) throw await apiError(res);
  return res.json();
};

/** Web 検索の有効 / 無効。保存した瞬間から、既存のセッションの次の呼び出しにも効く */
export const putWebSearchSettings = async (enabled: boolean): Promise<WebSearchMutationResponse> => {
  const res = await client.api.settings["web-search"].$put({ json: { enabled } });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as WebSearchMutationResponse;
};

/** 既定の検索プロバイダー。選んだ時点で保存され、次の検索から使われる */
export const putWebSearchProvider = async (provider: WebSearchProviderId): Promise<WebSearchMutationResponse> => {
  const res = await client.api.settings["web-search"].provider.$put({ json: { provider } });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as WebSearchMutationResponse;
};

/** provider の APIキーの登録・上書き。値は応答へ返らず、画面は設定済みかだけを受け取る */
export const putWebSearchApiKey = async (
  provider: WebSearchProviderId,
  apiKey: string,
): Promise<WebSearchMutationResponse> => {
  const res = await client.api.settings["web-search"].providers[":provider"].key.$put({
    param: { provider },
    json: { apiKey },
  });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as WebSearchMutationResponse;
};

/** provider の APIキーの削除（行ごと消して未設定へ戻す）。未設定でも 200 の冪等 */
export const deleteWebSearchApiKey = async (provider: WebSearchProviderId): Promise<WebSearchMutationResponse> => {
  const res = await client.api.settings["web-search"].providers[":provider"].key.$delete({
    param: { provider },
  });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as WebSearchMutationResponse;
};

/**
 * 画像モデル一覧の再取得。取得できなくても 200 で、失敗は catalogError にだけ載る（一覧は手元に残る）。
 * 設定は変わらないため、応答は一覧と出どころだけを返す。
 */
export const refreshImageCatalog = async (): Promise<ImageCatalogRefreshResponse> => {
  const res = await client.api.settings.content.image.catalog.refresh.$post();
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as ImageCatalogRefreshResponse;
};

/**
 * 音声モデル一覧の再取得。形と失敗の扱いは画像と同じ（常に 200 で、失敗は catalogError にだけ載る）。
 */
export const refreshSpeechCatalog = async (): Promise<SpeechCatalogRefreshResponse> => {
  const res = await client.api.settings.content.speech.catalog.refresh.$post();
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as SpeechCatalogRefreshResponse;
};

export const getRuntimeServeStatus = async (signal?: AbortSignal): Promise<RuntimeServeStatus> => {
  const res = await client.api.serve.runtime.status.$get({}, { init: { signal } });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as RuntimeServeStatus;
};

export const stopRuntimeServe = async (
  input: { generation: string },
  signal?: AbortSignal,
): Promise<RuntimeServeStatus> => {
  const res = await client.api.serve.runtime.stop.$post({ json: input }, { init: { signal } });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as RuntimeServeStatus;
};

/**
 * 作業環境 → 環境変数の要求元。会話 (sessionId) か、まだ会話が無いプロジェクト起点の新規会話 (projectId)。
 * cwd はサーバーが解決するため client は送らない。
 */
export type SecretsScope = { sessionId?: string; projectId?: string };

function scopeQuery(scope: SecretsScope): { sessionId?: string; projectId?: string } {
  return {
    ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
    ...(scope.projectId ? { projectId: scope.projectId } : {}),
  };
}

/** `/api/secrets/:secretId` の URL。hc の `$url` は param しか取らない面があるため、query は後から載せる */
function detailUrl(scope: SecretsScope, secretId: string): URL {
  const url = client.api.secrets[":secretId"].$url({ param: { secretId } });
  url.search = new URLSearchParams(scopeQuery(scope)).toString();
  return url;
}
