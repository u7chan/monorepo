import { client, ensureOk, read } from "./http";
import type {
  AgentDef,
  CatalogResponse,
  CreateAgentBody,
  CreateFileSkillBody,
  FileDownloadCheck,
  FileSkillsResponse,
  PromptDef,
  PromptResponse,
  PromptsResponse,
  SandboxSkillCreateResult,
  SandboxSkillDeletePreview,
  SandboxSkillFileDetail,
  SandboxSkillSaveResult,
  SandboxSkillsImportApply,
  SandboxSkillsImportPlan,
  SaveFileSkillBody,
  UpdateAgentBody,
  UpdatePromptBody,
  CreatePromptBody,
} from "../types";

export const getCatalog = async (): Promise<CatalogResponse> => {
  const res = await ensureOk(client.api.agents.$get());
  return res.json();
};

export const createAgent = async (input: CreateAgentBody): Promise<{ agent: AgentDef }> => {
  const res = await ensureOk(client.api.agents.$post({ json: input }));
  return res.json();
};

export const updateAgent = async (id: string, input: UpdateAgentBody): Promise<{ agent: AgentDef }> => {
  const res = await ensureOk(client.api.agents[":id"].$patch({ param: { id }, json: input }));
  return res.json();
};

export const deleteAgent = async (id: string): Promise<unknown> => {
  const res = await ensureOk(client.api.agents[":id"].$delete({ param: { id } }));
  return res.json();
};

export const reorderAgents = async (ids: readonly string[]): Promise<{ agents: AgentDef[] }> => {
  const res = await ensureOk(client.api.agents.order.$patch({ json: { ids: [...ids] } }));
  return res.json();
};

/** エージェントの応答に載る解決済みの定型文は `getCatalog` (`agents[].prompts`) が持つ */
export const getPrompts = async (): Promise<PromptsResponse> => {
  const res = await ensureOk(client.api.prompts.$get());
  return res.json();
};

export const reorderPrompts = async (ids: readonly string[]): Promise<PromptsResponse> => {
  const res = await ensureOk(client.api.prompts.order.$patch({ json: { ids: [...ids] } }));
  return res.json();
};

export const createPrompt = async (input: CreatePromptBody): Promise<{ prompt: PromptDef }> => {
  const res = await ensureOk(client.api.prompts.$post({ json: input }));
  return res.json();
};

export const updatePrompt = async (id: string, input: UpdatePromptBody): Promise<PromptResponse> => {
  const res = await ensureOk(client.api.prompts[":id"].$patch({ param: { id }, json: input }));
  return res.json();
};

export const deletePrompt = async (id: string): Promise<unknown> => {
  const res = await ensureOk(client.api.prompts[":id"].$delete({ param: { id } }));
  return res.json();
};

export const getFileSkills = () => read<FileSkillsResponse>(client.api.skills.files.$get());

export const getFileSkillDetail = (relativePath: string) =>
  read<SandboxSkillFileDetail>(client.api.skills.files.detail.$get({ query: { relativePath } }));

export const createFileSkill = (input: CreateFileSkillBody) =>
  read<SandboxSkillCreateResult>(client.api.skills.files.$post({ json: input }));

export const saveFileSkill = (input: SaveFileSkillBody) =>
  read<SandboxSkillSaveResult>(client.api.skills.files.$patch({ json: input }));

export const getFileSkillDeletePreview = (relativePath: string) =>
  read<SandboxSkillDeletePreview>(client.api.skills.files["delete-preview"].$get({ query: { relativePath } }));

/** 確認で取った `treeVersion` を渡す。一致しなければ 409 なので、最新の確認を取り直してから送る */
export const deleteFileSkill = async (relativePath: string, treeVersion: string): Promise<void> => {
  await ensureOk(client.api.skills.files.$delete({ query: { relativePath, treeVersion } }));
};

export const getSkillsExportCheck = () => read<FileDownloadCheck>(client.api.skills.files.export.check.$get());

/** 本文は fetch せずブラウザに任せる (`<a download>` の href) */
export const skillsExportUrl = (): string => client.api.skills.files.export.$url().toString();

/** plan と apply は同じ `File` を送る（判定はサーバーが受信した ZIP で行う） */
export const planSkillsImport = (file: File) =>
  read<SandboxSkillsImportPlan>(
    fetch(client.api.skills.files.import.$url({ query: { dryRun: "true" } }), {
      method: "POST",
      body: file,
    }),
  );

export const applySkillsImport = (file: File, replace: readonly string[]) =>
  read<SandboxSkillsImportApply>(
    fetch(client.api.skills.files.import.$url({ query: { replace: [...replace] } }), {
      method: "POST",
      body: file,
    }),
  );
