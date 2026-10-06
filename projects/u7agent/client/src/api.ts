import { hc } from "hono/client";
import type { AppType } from "server";
import { encodeFilePathParam } from "./lib/fileUrl";
import type {
  AgentDef,
  ArchiveSettingsResponse,
  AskUserAnswer,
  CatalogResponse,
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
  ImageMutationResponse,
  ImageSettingsResponse,
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
  SessionPayload,
  SessionSkillsPreview,
  SessionSkillsResponse,
  SessionSummary,
  SessionTitleResponse,
  SkillDef,
  StopResult,
  ThinkingLevel,
  UpdateAgentBody,
  UpdateImageSelectionBody,
  UpdateModelAvailabilityBody,
  UpdateNotificationsBody,
  UpdateSkillBody,
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

// Vite dev は /api を 4317 へプロキシするため同一オリジンで扱える
const client = hc<AppType>(location.origin);

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

/**
 * セッションで使えるスキル (プロジェクト / 共通 / 組み込み / エージェント割り当て)。
 * 本文は載らないため、本文の取得は送信時の BFF が行う。
 */
export const getSessionSkills = async (sessionId: string): Promise<SessionSkillsResponse> => {
  const res = await client.api.sessions[":id"].skills.$get({ param: { id: sessionId } });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as SessionSkillsResponse;
};

/**
 * セッション未確定 (新規チャット) のスキル一覧。作成前に選んでいるプロジェクト / エージェントで解決するため、
 * セッションが確定したら getSessionSkills へ切り替える (セッションは保存されたスナップショットで解決する)。
 */
export const getSessionSkillsPreview = async (input: {
  projectId: string;
  agentId: string;
}): Promise<SessionSkillsPreview> => {
  // 未所属 / 未選択はキーを送らず、初期値の解決はサーバーに任せる (createSession と同じ規則)
  const res = await client.api.skills.session.$get({
    query: {
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
    },
  });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as SessionSkillsPreview;
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

export const listProjects = async (): Promise<ProjectsResponse> => {
  const res = await client.api.projects.$get();
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export type CreateProjectInput = {
  cwd: string;
  name?: string;
  create?: boolean;
};

export const createProject = async (input: CreateProjectInput): Promise<{ project: Project }> => {
  const res = await client.api.projects.$post({ json: input });
  if (!res.ok) throw await apiError(res);
  // 400 (cwd 不正) / 409 (登録済み) / 503 (未設定) の応答型が残るため、!ok を throw で切った後に DTO 型へ寄せる
  return (await res.json()) as { project: Project };
};

// 配下セッションは停止・破棄される (ワークスペースのディレクトリは残る)
export const deleteProject = async (projectId: string): Promise<unknown> => {
  const res = await client.api.projects[":id"].$delete({ param: { id: projectId } });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export const listSessions = async (): Promise<{ sessions: SessionSummary[] }> => {
  const res = await client.api.sessions.$get();
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export type SessionOverrides = {
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
};

export type CreateSessionOverrides = SessionOverrides & { projectId?: string; notify?: boolean };

export const createSession = async (
  agentId?: string,
  overrides: CreateSessionOverrides = {},
): Promise<SessionPayload> => {
  const json: {
    agentId?: string;
    model?: ModelRef;
    thinkingLevel?: ThinkingLevel;
    projectId?: string;
    notify?: boolean;
  } = {
    ...overrides,
  };
  if (agentId) json.agentId = agentId;
  const res = await client.api.sessions.$post({ json });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export const getSession = async (sessionId: string): Promise<SessionPayload> => {
  const res = await client.api.sessions[":id"].$get({ param: { id: sessionId } });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

/**
 * 全履歴のカーソルページ。`before` より古い範囲を返し、初回 (before 無し) は最新ページだけを取る。
 * カーソルは entry id なので、追記・圧縮・再接続を跨いでも同じ item を二度返さない。
 */
export const getSessionHistory = async (
  sessionId: string,
  options: { before?: string | null; limit?: number } = {},
): Promise<HistoryPage> => {
  const query: Record<string, string> = {};
  if (options.before) query.before = options.before;
  if (options.limit !== undefined) query.limit = String(options.limit);
  // query validator を持たないルートのため、hc の $get ではなく URL を組んで fetch する
  const url = client.api.sessions[":id"].history.$url({ param: { id: sessionId } });
  url.search = new URLSearchParams(query).toString();
  const res = await fetch(url);
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export const deleteSession = async (sessionId: string): Promise<unknown> => {
  const res = await client.api.sessions[":id"].$delete({ param: { id: sessionId } });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export const updateSessionSettings = async (sessionId: string, settings: SessionOverrides): Promise<SessionPayload> => {
  const res = await client.api.sessions[":id"].settings.$patch({
    param: { id: sessionId },
    json: settings,
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

/**
 * 会話ごとの通知トグル。Model / Effort の設定変更とは別の経路で、実行中でも切り替えられる。
 * 応答は会話全文を含まない (`{ sessionId, notify }`)。
 */
export const updateSessionNotify = async (sessionId: string, notify: boolean): Promise<SessionNotifyResponse> => {
  const res = await client.api.sessions[":id"].notify.$patch({ param: { id: sessionId }, json: { notify } });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

/**
 * 会話タイトルの変更。通知トグルと同じ専用経路で、実行中でも変えられる。
 * 応答の `title` は正規化 (trim / マスク / 上限) 後で、一覧の表示にそのまま使える。
 */
export const updateSessionTitle = async (sessionId: string, title: string): Promise<SessionTitleResponse> => {
  const res = await client.api.sessions[":id"].title.$patch({ param: { id: sessionId }, json: { title } });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export const stopSession = async (sessionId: string): Promise<StopResult> => {
  const res = await client.api.sessions[":id"].stop.$post({ param: { id: sessionId } });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

/**
 * 手動でのコンテキスト圧縮。body なしで、完了まで待って実効状態を返す（途中経過は SSE が配る）。
 * 失敗は 400（要約できる履歴が無い）/ 409（実行中・中止・圧縮済み）/ 500（保存失敗）で reject する。
 */
export const compactSession = async (sessionId: string): Promise<SessionCompactionResult> => {
  const res = await client.api.sessions[":id"].compact.$post({ param: { id: sessionId } });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

// 202 を即時返す。実行は裏で続き、進捗は SSE で届く。attachments は root 相対の `<appdir>/uploads/<sessionId>/` 配下
// (本文が空でも添付だけで送れる)
export const postMessage = async (
  sessionId: string,
  text: string,
  attachments: string[] = [],
): Promise<PostMessageResult> => {
  const json = attachments.length > 0 ? { text, attachments } : { text };
  const res = await client.api.sessions[":id"].messages.$post({ json, param: { id: sessionId } });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

/**
 * 未送信メッセージの再送。本文はサーバーが保存済みの生テキストを使う (表示用のマスク済み本文を
 * 送り直さない)。同じ run id で実行し直し、二重の再送はサーバーが弾く。
 */
export const resendMessage = async (sessionId: string, runId: string): Promise<PostMessageResult> => {
  const res = await client.api.sessions[":id"].messages.$post({
    json: { resendRunId: runId },
    param: { id: sessionId },
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

/** 未送信メッセージの破棄。再送が実行中の 409 はそのまま reject する */
export const discardUnsentMessage = async (sessionId: string, runId: string): Promise<DiscardUnsentResult> => {
  const res = await client.api.sessions[":id"].unsent[":runId"].$delete({ param: { id: sessionId, runId } });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

/**
 * ask_user の回答。回答は 1 回だけ成立し、同じ質問への 2 回目は 409、回答待ちでない (停止済み・
 * 再起動) は 404、質問数と合わない回答は 400 で reject する。
 */
export const answerQuestion = async (
  sessionId: string,
  toolCallId: string,
  answers: AskUserAnswer[],
): Promise<{ ok: true }> => {
  const res = await client.api.sessions[":id"].questions[":toolCallId"].answer.$post({
    json: { answers },
    param: { id: sessionId, toolCallId },
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export type SessionFileUpload = {
  sessionId: string;
  /** root 相対の保存パス (`.u7agent/uploads/<sessionId>/…`)。raw URL にそのまま使える */
  path: string;
  name: string;
  renamed: boolean;
  size: number;
};

/**
 * 選択時の即時アップロード。本文は File をそのまま raw ストリームで送る (JSON / base64 にしない) ため、
 * hc の型付き呼び出しではなく $url で組み立てた URL へ fetch する。
 */
export const uploadSessionFile = async (sessionId: string, file: File): Promise<SessionFileUpload> => {
  const url = client.api.sessions[":id"].files.$url({ param: { id: sessionId }, query: { name: file.name } });
  const res = await fetch(url, { method: "POST", body: file });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as SessionFileUpload;
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
 * 設定 → モデルの画像生成タブ（純粋読取）。APIキーは含まれず、登録済みでも値は返らない。
 * モデルの選択肢はカタログ（models）で、キー未設定なら configured: false。
 */
export const getImageSettings = async (): Promise<ImageSettingsResponse> => {
  const res = await client.api.settings.images.$get();
  if (!res.ok) throw await apiError(res);
  return res.json();
};

/** 画像生成の provider / model の変更。キーは保持され、行が無ければ 400 */
export const putImageSettings = async (input: UpdateImageSelectionBody): Promise<ImageMutationResponse> => {
  const res = await client.api.settings.images.$put({ json: input });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as ImageMutationResponse;
};

/** 画像専用APIキーの登録・上書き。行が無ければ既定 provider / model で作成される */
export const putImageApiKey = async (apiKey: string): Promise<ImageMutationResponse> => {
  const res = await client.api.settings.images.key.$put({ json: { apiKey } });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as ImageMutationResponse;
};

/** 画像専用APIキーの削除（行ごと消して未設定へ戻す）。未設定でも 200 の冪等 */
export const deleteImageApiKey = async (): Promise<ImageMutationResponse> => {
  const res = await client.api.settings.images.key.$delete();
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as ImageMutationResponse;
};

/**
 * 画像モデル一覧の再取得。取得できなくても 200 で、失敗は catalogError にだけ載る（一覧は手元に残る）。
 * 設定は変わらないため、応答は一覧と出どころだけを返す。
 */
export const refreshImageCatalog = async (): Promise<ImageCatalogRefreshResponse> => {
  const res = await client.api.settings.images.catalog.refresh.$post();
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as ImageCatalogRefreshResponse;
};

/**
 * serve (サービス) の状態。閲覧中の会話 id を送り、作業ディレクトリはサーバーが解決する。
 * 到達可の判定はプローブで、取得失敗 (502 / 503) は「到達不可」とは別物として扱う。
 */
export const getServeStatus = async (sessionId: string, signal?: AbortSignal): Promise<ServeStatus> => {
  const res = await client.api.serve.status.$get({ query: { sessionId } }, { init: { signal } });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as ServeStatus;
};

/**
 * サービスの起動。到達可なら他会話のプロセスを停止して置き換える (確認は UI が取る)。
 * `generation` は確認した状態の世代で、実行時に変わっていれば 409 になる。
 */
export const startServe = async (
  input: { sessionId: string; generation: string | null },
  signal?: AbortSignal,
): Promise<ServeStatus> => {
  const res = await client.api.serve.start.$post({ json: input }, { init: { signal } });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as ServeStatus;
};

/** サービスの停止。所有者以外は 403、停止後の解放を確認できないときは 502 */
export const stopServe = async (input: { sessionId: string; generation: string | null }): Promise<ServeStatus> => {
  const res = await client.api.serve.stop.$post({ json: input });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as ServeStatus;
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

/**
 * 一覧。返るのは名前・種別・更新時刻だけで、シークレットの値は含まれない。
 * `generation` は変更のたびに変わるため、serve の `secretGeneration` と比べて「再起動で反映」を出せる。
 */
export const getSecrets = async (scope: SecretsScope, signal?: AbortSignal): Promise<SecretsListResponse> => {
  const res = await client.api.secrets.$get({ query: scopeQuery(scope) }, { init: { signal } });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as SecretsListResponse;
};

/**
 * 変更フォーム用の 1 件。`value` は変数のときだけ入り、シークレットでは返らない。
 * param + query のルートは hc が query を型として取らないため、history と同じく URL を組んで fetch する。
 */
export const getSecretDetail = async (
  scope: SecretsScope,
  secretId: string,
  signal?: AbortSignal,
): Promise<SecretDetailResponse> => {
  const url = detailUrl(scope, secretId);
  const res = await fetch(url, { signal });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as SecretDetailResponse;
};

/** 登録。名前の規則違反・重複は 400 / 409、master key 未設定のシークレットは 503 (state: not_stored) */
export const createSecret = async (
  input: SecretsScope & { kind: SecretKind; name: string; value: string },
): Promise<SecretMutationResponse> => {
  const res = await client.api.secrets.$post({ json: input });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as SecretMutationResponse;
};

/** 値の上書き。名前と種別は変えられない (変えたいときは削除して作り直す) */
export const updateSecret = async (
  scope: SecretsScope,
  secretId: string,
  value: string,
): Promise<SecretMutationResponse> => {
  const res = await client.api.secrets[":secretId"].$put({
    param: { secretId },
    json: { ...scopeQuery(scope), value },
  });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as SecretMutationResponse;
};

/** 削除。確認 1 回は呼び出し側 (UI) が取る */
export const deleteSecret = async (scope: SecretsScope, secretId: string): Promise<SecretRemovalResponse> => {
  const res = await fetch(detailUrl(scope, secretId), { method: "DELETE" });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as SecretRemovalResponse;
};
