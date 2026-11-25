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

/** 並べ替え。応答の agents がサーバーの採用した順（定義は変えない） */
export const reorderAgents = async (ids: readonly string[]): Promise<{ agents: AgentDef[] }> => {
  const res = await ensureOk(client.api.agents.order.$patch({ json: { ids: [...ids] } }));
  return res.json();
};

/**
 * 定型プロンプトのマスタ一覧。使用先 (`usedBy`) つきで、組み込みが先に並ぶ。自作は保存した順。
 * エージェントの応答に載る解決済みの定型文はカタログ側 (`getCatalog`) が持つ。
 */
export const getPrompts = async (): Promise<PromptsResponse> => {
  const res = await ensureOk(client.api.prompts.$get());
  return res.json();
};

/** 並べ替え。応答の prompts がサーバーの採用した順（定義は変えない） */
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

/** 削除は使用中 (409) を ApiError で返す。使用先は本文の `usedBy` に載る */
export const deletePrompt = async (id: string): Promise<unknown> => {
  const res = await ensureOk(client.api.prompts[":id"].$delete({ param: { id } }));
  return res.json();
};

/**
 * 共通スキル (`.agents/skills`) の一覧。サンドボックス未設定は 503、サンドボックス側の失敗は
 * 502 で reject する。
 */
export const getFileSkills = () => read<FileSkillsResponse>(client.api.skills.files.$get());

/**
 * 共通スキル 1 件の編集内容。name / description は SDK の発見結果、body は frontmatter を除いた原文で
 * trim しない。保存できないファイルは editable: false と reason が入る (閲覧はできる)。
 */
export const getFileSkillDetail = (relativePath: string) =>
  read<SandboxSkillFileDetail>(client.api.skills.files.detail.$get({ query: { relativePath } }));

/** 共通スキルの新規作成。同名や既存ディレクトリは 409 で reject する */
export const createFileSkill = (input: CreateFileSkillBody) =>
  read<SandboxSkillCreateResult>(client.api.skills.files.$post({ json: input }));

/** 共通スキルの保存。版の不一致 (409) と、安全に差し替えられない frontmatter (400) は reject する */
export const saveFileSkill = (input: SaveFileSkillBody) =>
  read<SandboxSkillSaveResult>(client.api.skills.files.$patch({ json: input }));

/**
 * 削除確認。何も変更せず、消えるフォルダ・付随ファイル・treeVersion を返す (取消は副作用なし)。
 */
export const getFileSkillDeletePreview = (relativePath: string) =>
  read<SandboxSkillDeletePreview>(client.api.skills.files["delete-preview"].$get({ query: { relativePath } }));

/** 専用フォルダの削除。確認で取った treeVersion を渡し、一致しなければ 409 で reject する */
export const deleteFileSkill = async (relativePath: string, treeVersion: string): Promise<void> => {
  await ensureOk(client.api.skills.files.$delete({ query: { relativePath, treeVersion } }));
};

/**
 * 共通スキルのエクスポートの事前チェック。`.agents/skills` が無ければ 404、上限超過は 413 で reject し、
 * 共通行が 0 件なら 200 の `entries: 0` になる（どちらも理由を画面へそのまま出す）。
 */
export const getSkillsExportCheck = () => read<FileDownloadCheck>(client.api.skills.files.export.check.$get());

/**
 * エクスポートの URL（`<a download>` の href）。一覧と同じく `.agents/skills` の ZIP で、保存名は応答の
 * `Content-Disposition` が決める。本文は fetch せずブラウザに任せる。
 */
export const skillsExportUrl = (): string => client.api.skills.files.export.$url().toString();

/**
 * インポートの plan（何も変更しない）。判定はサーバーが受信した ZIP で行うため、apply でも同じ `File` を送る。
 * 各スキルの status は new / identical / conflict / invalid で、invalid だけ reason を持つ。
 */
export const planSkillsImport = (file: File) =>
  read<SandboxSkillsImportPlan>(
    fetch(client.api.skills.files.import.$url({ query: { dryRun: "true" } }), {
      method: "POST",
      body: file,
    }),
  );

/**
 * インポートの適用。`replace` に挙げた conflict だけをフォルダごと置き換え、new は常にインポートする。
 * 送る ZIP は plan と同じ `File` で、plan のあとに変わっていても適用時の状態で判定される。
 */
export const applySkillsImport = (file: File, replace: readonly string[]) =>
  read<SandboxSkillsImportApply>(
    fetch(client.api.skills.files.import.$url({ query: { replace: [...replace] } }), {
      method: "POST",
      body: file,
    }),
  );
