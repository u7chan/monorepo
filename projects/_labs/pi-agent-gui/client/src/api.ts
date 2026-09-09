import { hc } from "hono/client";
import type { AppType } from "server";
import type {
  AgentDef,
  Catalog,
  Health,
  PostMessageResult,
  SessionPayload,
  SessionSummary,
  SkillDef,
  StopResult,
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

/** !ok レスポンスから ApiError を組み立てる。body の {error} を優先し、読めなければ HTTP <status> */
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
  // throw で制御フローを切ることで res.json() は成功型のみになる
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

export const createAgent = async (
  input: Pick<AgentDef, "name" | "description" | "systemPrompt" | "skillIds">,
): Promise<{ agent: AgentDef }> => {
  const res = await client.api.agents.$post({ json: input });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

export const updateAgent = async (
  id: string,
  input: Partial<Pick<AgentDef, "name" | "description" | "systemPrompt" | "skillIds">>,
): Promise<{ agent: AgentDef }> => {
  // catalog CRUD の body は zod 厳格化しない (pass-through) ため、hc の input 型に json が宣言されない。
  // 実行時は args.json が JSON body になる (hono/client 実装) ので、宣言済み引数型へ寄せて送る。
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
  // updateAgent と同じ理由で json を引数型へ寄せる
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

/** 201 でセッションの完全ペイロードが返る */
export const createSession = async (agentId?: string): Promise<SessionPayload> => {
  const res = await client.api.sessions.$post({ json: agentId ? { agentId } : {} });
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

export const stopSession = async (sessionId: string): Promise<StopResult> => {
  const res = await client.api.sessions[":id"].stop.$post({ param: { id: sessionId } });
  if (!res.ok) throw await apiError(res);
  return res.json();
};

/** 202 即時返却。実行はバックグラウンドで続き、イベントは SSE で届く */
export const postMessage = async (sessionId: string, text: string): Promise<PostMessageResult> => {
  const res = await client.api.sessions[":id"].messages.$post({ json: { text }, param: { id: sessionId } });
  if (!res.ok) throw await apiError(res);
  return res.json();
};
