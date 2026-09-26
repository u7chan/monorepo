import { hc } from "hono/client";
import type { AppType } from "server";
import { encodeFilePathParam } from "./lib/fileUrl";
import type {
  AgentDef,
  ArchiveSettingsResponse,
  CatalogResponse,
  CreateAgentBody,
  CreateSkillBody,
  FileDownloadCheck,
  FileListing,
  FilePreview,
  FileRename,
  FileSkillsResponse,
  Health,
  ModelRef,
  NotificationResult,
  NotificationsResponse,
  PostMessageResult,
  Project,
  ProjectsResponse,
  RuntimeEnvironmentResponse,
  RuntimeModelsResponse,
  SessionNotifyResponse,
  SessionPayload,
  SessionSkillsPreview,
  SessionSkillsResponse,
  SessionSummary,
  SkillDef,
  StopResult,
  ThinkingLevel,
  UpdateAgentBody,
  UpdateNotificationsBody,
  UpdateSkillBody,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
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
  return new ApiError(message, res.status);
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
 * 画像プレビュー用の raw URL。path はワークスペース root 相対で、配信できるのは allowlist の画像だけ。
 * 生配信に載せるため bodyGuard の上限を通らず、Content-Type はサーバーが決める。
 */
export const fileRawUrl = (path: string): string => client.api.files.raw.$url({ query: { path } }).toString();

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

export const stopSession = async (sessionId: string): Promise<StopResult> => {
  const res = await client.api.sessions[":id"].stop.$post({ param: { id: sessionId } });
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
