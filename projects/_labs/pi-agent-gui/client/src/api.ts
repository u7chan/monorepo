import { hc } from "hono/client";
import type { AppType } from "server";
import type {
  AgentDef,
  Catalog,
  Health,
  ModelRef,
  PostMessageResult,
  SessionPayload,
  SessionSummary,
  SkillDef,
  StopResult,
  ThinkingLevel,
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

/** 型安全クライアント (Vite dev は /api を 4317 にプロキシ済み) */
const client = hc<AppType>(location.origin);

/** !ok のレスポンスから ApiError を作る (body の {error} を優先し、読めなければ HTTP <status>)。 */
async function apiError(res: Response): Promise<ApiError> {
  const body: unknown = await res.json().catch(() => null);
  const message =
    typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : `HTTP ${res.status}`;
  return new ApiError(message, res.status);
}

// --- health / catalog ---

export const getHealth = async (): Promise<Health> => {
  const res = await client.api.health.$get();
  // throw で制御フローを切ると res.json() が成功型になる
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export const getCatalog = async (): Promise<Catalog> => {
  const res = await client.api.agents.$get();
  if (!res.ok) throw await apiError(res);
  return res.json();
};

/** 定義の一括置換 (インポート) */
export const replaceCatalog = async (catalog: { agents: unknown[]; skills: unknown[] }): Promise<Catalog> => {
  const res = await client.api.agents.$put({ json: catalog });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

// --- agents CRUD ---

export type AgentDefinitionInput = Pick<
  AgentDef,
  "name" | "description" | "systemPrompt" | "skillIds"
> & {
  model?: ModelRef | null;
  thinkingLevel?: ThinkingLevel | null;
};

export const createAgent = async (input: AgentDefinitionInput): Promise<{ agent: AgentDef }> => {
  const res = await client.api.agents.$post({ json: input });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export const updateAgent = async (
  id: string,
  input: Partial<AgentDefinitionInput>,
): Promise<{ agent: AgentDef }> => {
  // catalog CRUD の body は zod 厳格化しないため hc の input 型に json が現れない。
  // 実行時は args.json が JSON body になるので、宣言済みの引数型に寄せて送る。
  type PatchArgs = Parameters<(typeof client.api.agents)[":id"]["$patch"]>[0];
  const res = await client.api.agents[":id"].$patch({ param: { id }, json: input } as PatchArgs);
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export const deleteAgent = async (id: string): Promise<unknown> => {
  const res = await client.api.agents[":id"].$delete({ param: { id } });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

// --- skills CRUD ---

export const createSkill = async (input: Pick<SkillDef, "name" | "description" | "prompt">): Promise<{ skill: SkillDef }> => {
  const res = await client.api.skills.$post({ json: input });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export const updateSkill = async (
  id: string,
  input: Partial<Pick<SkillDef, "name" | "description" | "prompt">>,
): Promise<{ skill: SkillDef }> => {
  // updateAgent と同じ理由で json を引数型に寄せる
  type PatchArgs = Parameters<(typeof client.api.skills)[":id"]["$patch"]>[0];
  const res = await client.api.skills[":id"].$patch({ param: { id }, json: input } as PatchArgs);
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export const deleteSkill = async (id: string): Promise<unknown> => {
  const res = await client.api.skills[":id"].$delete({ param: { id } });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

// --- sessions ---

export const listSessions = async (): Promise<{ sessions: SessionSummary[] }> => {
  const res = await client.api.sessions.$get();
  if (!res.ok) throw await apiError(res);
  return res.json();
};

/** 未指定の項目は定義 → アプリ既定へ解決される */
export type SessionOverrides = {
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
};

/** 201 でセッションの完全な payload が返る */
export const createSession = async (agentId?: string, overrides: SessionOverrides = {}): Promise<SessionPayload> => {
  const json: { agentId?: string; model?: ModelRef; thinkingLevel?: ThinkingLevel } = { ...overrides };
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

/** 省略した項目は現在値を維持する。SDK 補正後の実効値を含む SessionPayload が返る。 */
export const updateSessionSettings = async (
  sessionId: string,
  settings: SessionOverrides,
): Promise<SessionPayload> => {
  const res = await client.api.sessions[":id"].settings.$patch({
    param: { id: sessionId },
    json: settings,
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export const stopSession = async (sessionId: string): Promise<StopResult> => {
  const res = await client.api.sessions[":id"].stop.$post({ param: { id: sessionId } });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

/** 202 を即時返す。実行はバックグラウンドで続き、イベントは SSE で届く。 */
export const postMessage = async (sessionId: string, text: string): Promise<PostMessageResult> => {
  const res = await client.api.sessions[":id"].messages.$post({ json: { text }, param: { id: sessionId } });
  if (!res.ok) throw await apiError(res);
  return res.json();
};
