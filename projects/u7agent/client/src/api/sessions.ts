import { hc } from "hono/client";
import type { AppType } from "server";
import { apiError, client } from "./http";
import type {
  ApproveNetworkAccessResponse,
  AskUserAnswer,
  CancelQueuedResult,
  DiscardUnsentResult,
  HistoryPage,
  ModelRef,
  PostMessageResult,
  Project,
  ProjectsResponse,
  SecretDetailResponse,
  SecretKind,
  SecretMutationResponse,
  SecretRemovalResponse,
  SecretsListResponse,
  ServeStatus,
  SessionCompactionResult,
  SessionDiagnostics,
  SessionHistoryClearResponse,
  SessionMoveResponse,
  SessionNotifyResponse,
  SessionPinnedResponse,
  SessionPayload,
  SessionSkillsPreview,
  SessionSkillsResponse,
  SessionSummary,
  SessionTitleSummaryResponse,
  SessionTitleResponse,
  StopResult,
  ThinkingLevel,
} from "../types";

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
  /** root 相対の保存パス。既定 / 追加スペースの添付置き場をそのまま raw URL に使える */
  path: string;
  name: string;
  renamed: boolean;
  size: number;
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
    /**
     * 全スペースの一覧。`scope=all` は `spaceId` を付けない unscoped な取得で、サイドバーの
     * 現在スペースの絞り込みはクライアントが行う (一覧の state は全スペースで 1 本)。
     */
    listSessions: () => read<{ sessions: SessionSummary[] }>(client.api.sessions.$get({ query: { scope: "all" } })),
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
    // 引き継ぎの要求元は query (この API の spaceId)、移動先は body。移動先で作った API から呼ぶと
    // query が移動先になり、sessionSpaceGuard が 404 にする (この module の scope が query を書く)
    handoffSession: (id: string, json: { spaceId: string; agentId?: string; memo: boolean }) =>
      read<SessionMoveResponse>(session.move.$post({ param: { id }, json })),
    // 履歴のクリアは同じ URL のまま。確認時点の履歴世代を送り、変わっていれば 409 になる
    clearSessionHistory: (id: string, json: { historyGeneration: string }) =>
      read<SessionHistoryClearResponse>(session.history.clear.$post({ param: { id }, json })),
    // 分岐は要求元スペース (この API の spaceId) の会話にだけ行える。子は同じスペースにできる
    forkSession: (id: string, json: { agentId?: string }) =>
      read<SessionPayload>(session.fork.$post({ param: { id }, json })),
    updateSessionSettings: (id: string, json: SessionOverrides) =>
      read<SessionPayload>(session.settings.$patch({ param: { id }, json })),
    updateSessionNotify: (id: string, notify: boolean) =>
      read<SessionNotifyResponse>(session.notify.$patch({ param: { id }, json: { notify } })),
    updateSessionPinned: (id: string, pinned: boolean) =>
      read<SessionPinnedResponse>(session.pin.$patch({ param: { id }, json: { pinned } })),
    updateSessionTitle: (id: string, title: string) =>
      read<SessionTitleResponse>(session.title.$patch({ param: { id }, json: { title } })),
    summarizeSessionTitle: (id: string) =>
      read<SessionTitleSummaryResponse>(session.title.summarize.$post({ param: { id } })),
    stopSession: (id: string) => read<StopResult>(session.stop.$post({ param: { id } })),
    compactSession: (id: string) => read<SessionCompactionResult>(session.compact.$post({ param: { id } })),
    postMessage: (id: string, text: string, attachments: string[] = [], titleSource?: string) =>
      read<PostMessageResult>(
        session.messages.$post({
          param: { id },
          json: { text, attachments, ...(titleSource === undefined ? {} : { titleSource }) },
        }),
      ),
    resendMessage: (id: string, sendId: string) =>
      read<PostMessageResult>(session.messages.$post({ param: { id }, json: { resendSendId: sendId } })),
    discardUnsentMessage: (id: string, sendId: string) =>
      read<DiscardUnsentResult>(session.unsent[":sendId"].$delete({ param: { id, sendId } })),
    cancelQueuedMessage: (id: string, sendId: string) =>
      read<CancelQueuedResult>(session.queue[":sendId"].$delete({ param: { id, sendId } })),
    answerQuestion: (id: string, toolCallId: string, answers: AskUserAnswer[]) =>
      read<{ ok: true }>(
        session.questions[":toolCallId"].answer.$post({ param: { id, toolCallId }, json: { answers } }),
      ),
    /** 拒否済みの承認カードから許可へ変える。host はカードに出た接続先をそのまま渡す */
    approveNetworkAccess: (id: string, host: string) =>
      read<ApproveNetworkAccessResponse>(session["network-access"].approve.$post({ param: { id }, json: { host } })),
    uploadSessionFile: (id: string, file: File) =>
      read<SessionFileUpload>(
        fetch(scope(session.files.$url({ param: { id }, query: { name: file.name } })), {
          method: "POST",
          body: file,
        }),
      ),
    getSessionSkills: (id: string) => read<SessionSkillsResponse>(session.skills.$get({ param: { id } })),
    /** 切り分け用のダンプ。本文は含まれず、mask 済みのイベント要約を返す */
    getSessionDiagnostics: (id: string) => read<SessionDiagnostics>(session.diagnostics.$get({ param: { id } })),
    /**
     * 生ログ (session.jsonl。mask 前)。未保存の会話は 404 なので、本文を読む前に status を確かめる。
     * 文字列化せず Blob のまま返す (BOM や不正 UTF-8 を再エンコードで改変しない)。
     */
    getSessionRawLog: async (id: string): Promise<Blob> => {
      const res = await fetch(scope(session.raw.$url({ param: { id } })));
      if (!res.ok) throw await apiError(res);
      return res.blob();
    },
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
    /** 並べ替え。応答の items がサーバーの採用した順（値は含まれない） */
    reorderSecrets: (input: SecretsScope, ids: readonly string[]) =>
      read<SecretsListResponse>(scoped.api.secrets.order.$patch({ json: { ...scopeQuery(input), ids: [...ids] } })),
  };
}
