/** pi ランタイムとインメモリセッションのファクトリ。認証はあえて pi の通常の解決 (auth.json / OAuth / プロバイダー環境変数) に委ねる。 */
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, Model as PiAiModel } from "@earendil-works/pi-ai";
import { join, resolve } from "node:path";
import { ThinkingLevelSchema } from "./schema";
import { createSandboxToolClientFromEnv } from "./sandbox/client";
import { createRemoteToolDefinitions } from "./sandbox/remote-tools";
import type { SecretMasker } from "./redact";
import { createRuntimeSecretMasker, createSecretRedactionExtension } from "./secret-guard";
import type { AgentDef, ModelOption, ModelRef, SkillDef, ThinkingLevel } from "./schema";

export interface PiModelRef {
  provider: string;
  id: string;
}

/** UI にそのまま表示する認証未設定時の案内。 */
export const AUTH_REQUIRED_MESSAGE =
  "APIキーが未設定です。ANTHROPIC_API_KEY などのプロバイダー用キーを設定するか、保存済みの認証情報を確認してからサーバーを再起動してください。";

/** UI にそのまま表示するサンドボックス未設定時の案内。 */
export const SANDBOX_NOT_CONFIGURED_MESSAGE =
  "サンドボックスが設定されていません。PI_SANDBOX_URL と PI_SANDBOX_TOKEN を設定してサーバーを再起動してください (ローカルでのツール実行にはフォールバックしません)。";

const MODEL_UNAVAILABLE_MESSAGE =
  "利用可能なモデルがありません。既定モデルまたはプロバイダーの設定を確認してください。";

/** PI_MODELS の指定が利用可能モデルと交差しなかったときの案内。 */
export const MODEL_WHITELIST_EMPTY_MESSAGE =
  "PI_MODELS に指定したモデルが利用可能なモデルにありません。PI_MODELS の指定とプロバイダーの認証設定を確認してください。";

const APPEND_SYSTEM_PROMPT = `
You are running inside a small browser UI.
Respond in Japanese by default, unless the user asks for another language.
Keep answers practical and concise. The working directory is the user's local project.
When a task involves the project, inspect it with the available tools instead of guessing.
Do not reveal private chain-of-thought; provide a short useful summary of your reasoning instead.
`.trim();

const DEFAULT_TOOLS = process.platform === "win32"
  ? ["read", "powershell", "edit", "write", "grep", "find", "ls"]
  : ["read", "bash", "edit", "write", "grep", "find", "ls"];

export interface CreateSessionInput {
  agent?: AgentDef;
  skills?: SkillDef[];
  /** 解決済みの指定。未指定ならアプリ既定。 */
  model?: ModelRef;
  /** 解決済みの指定。未指定ならアプリ既定。 */
  thinkingLevel?: ThinkingLevel;
}

export interface PiBff {
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  /** アプリ既定モデル (利用可能なときのみ) */
  selectedModel: PiModelRef | undefined;
  availableModels: PiModelRef[];
  /** picker 用の候補と能力情報 (認証済みモデルのみ) */
  modelOptions: ModelOption[];
  /** アプリ既定の thinkingLevel */
  defaultThinkingLevel: ThinkingLevel;
  /** 明示 PI_MODEL が利用不能なときの理由 (他候補があれば ready のまま) */
  defaultModelError: string | undefined;
  availabilityError: string | undefined;
  /** PI_MODELS が候補を全部落とした (ready: false の原因が whitelist だと health が判定するため) */
  modelWhitelistExcludesAll: boolean;
  /** PI_SANDBOX_URL / PI_SANDBOX_TOKEN が揃っていれば true (未設定ならセッション作成を 503 で拒否) */
  sandboxConfigured: boolean;
  tools: string[];
  resolveModel(model: ModelRef): CreateAgentSessionOptions["model"] | undefined;
  createSession(input?: CreateSessionInput): Promise<{ session: unknown }>;
  modelLabel(model?: PiModelRef | null): string | undefined;
  /** ツール出力や SSE から既知の秘密値を除くマスカー (保護対象が無ければ素通し) */
  secretMasker: SecretMasker;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 未知の段階は設定ミスとして例外にする。 */
function parseThinkingLevel(value: string): ThinkingLevel {
  const parsed = ThinkingLevelSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Effort の値が不正です: ${value}`);
  return parsed.data;
}

/**
 * PI_MODEL / PI_THINKING を構文解釈する。利用可否の照合は createPiBff 側で行う。
 */
function parseModelReference(): { model: ModelRef; thinkingLevel: ThinkingLevel | undefined } | undefined {
  const rawValue = process.env.PI_MODEL?.trim();
  if (!rawValue) {
    return undefined;
  }

  let reference = rawValue;
  let thinkingLevel = process.env.PI_THINKING?.trim() || undefined;
  const thinkingSuffix = reference.match(/:(off|minimal|low|medium|high|xhigh|max)$/);
  if (thinkingSuffix) {
    reference = reference.slice(0, -thinkingSuffix[0].length);
    thinkingLevel = thinkingSuffix[1];
  }

  const parsedLevel =
    thinkingLevel === undefined ? undefined : parseThinkingLevel(thinkingLevel);

  const slash = reference.indexOf("/");
  const provider = slash === -1 ? process.env.PI_PROVIDER?.trim() : reference.slice(0, slash);
  const modelId = slash === -1 ? reference : reference.slice(slash + 1);
  if (!provider || !modelId) {
    throw new Error("既定モデルは provider/model 形式で指定してください（プロバイダーを別に指定することもできます）");
  }

  return { model: { provider, id: modelId }, thinkingLevel: parsedLevel };
}

/**
 * PI_MODELS を構文解釈する。未指定 (空・区切りのみ) なら undefined で全件表示。
 * 形式の誤りは whitelist が効かないまま起動するより起動時に落とす (fail-closed)。
 */
export function parseModelWhitelist(raw: string | undefined): ModelRef[] | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) return undefined;
  return entries.map((entry) => {
    const slash = entry.indexOf("/");
    const provider = slash === -1 ? "" : entry.slice(0, slash);
    const id = slash === -1 ? "" : entry.slice(slash + 1);
    if (!provider || !id) {
      throw new Error(`PI_MODELS は provider/model 形式でカンマ区切りで指定してください: ${entry}`);
    }
    return { provider, id };
  });
}

/**
 * available と PI_MODELS の積。availableModels / modelOptions / selectedModel / resolveModel は
 * 同じ配列から導出するため、絞り込みはここ 1 箇所だけに閉じる。
 */
export function filterModelsByWhitelist(
  models: PiAiModel<Api>[],
  whitelist: ModelRef[] | undefined,
): PiAiModel<Api>[] {
  if (!whitelist) return models;
  return models.filter((model) =>
    whitelist.some((ref) => ref.provider === model.provider && ref.id === model.id),
  );
}

/** picker 用の能力情報。SDK のヘルパーをそのまま使い、BFF 側で模倣しない。 */
function modelOptionOf(model: PiAiModel<Api>): ModelOption {
  const levels = getSupportedThinkingLevels(model) as ThinkingLevel[];
  return {
    provider: model.provider,
    id: model.id,
    name: model.name || `${model.provider}/${model.id}`,
    supportsThinking: levels.some((level) => level !== "off"),
    thinkingLevels: levels,
  };
}

function configuredTools(): string[] {
  const value = process.env.PI_AGENT_TOOLS?.trim();
  if (!value) return DEFAULT_TOOLS;
  const tools = value.split(",").map((tool) => tool.trim()).filter(Boolean);
  return tools.length > 0 ? tools : DEFAULT_TOOLS;
}

function modelLabel(model?: PiModelRef | null): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

export async function createPiBff({ cwd = process.cwd() }: { cwd?: string } = {}): Promise<PiBff> {
  const projectCwd = resolve(cwd);
  const agentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  // 保護対象は BFF が環境変数で受け取ったキーの非空値だけで、認証に使う process.env 自体は変更しない。
  const secretMasker = createRuntimeSecretMasker(modelRuntime.getProviders(), process.env);
  // 作業用ツールはすべてサンドボックス (別プロセス) で実行し、BFF ローカル実行へはフォールバックしない。
  const sandboxClient = createSandboxToolClientFromEnv(process.env);

  const requested = parseModelReference();
  const modelWhitelist = parseModelWhitelist(process.env.PI_MODELS);
  let availableModelList: PiAiModel<Api>[] = [];
  let availabilityError: string | undefined;

  try {
    availableModelList = [...await modelRuntime.getAvailable()];
  } catch (error) {
    availabilityError = errorMessage(error);
  }
  availableModelList = filterModelsByWhitelist(availableModelList, modelWhitelist);
  const availableModels: PiModelRef[] = availableModelList;

  let modelWhitelistExcludesAll = false;
  if (modelWhitelist && !availabilityError && availableModelList.length === 0) {
    // 認証が未設定でも whitelist は必ず空になるため、対処先を絞れるよう両方を確認させる文言で返す。
    modelWhitelistExcludesAll = true;
    availabilityError = MODEL_WHITELIST_EMPTY_MESSAGE;
  }

  // getModel() は認証の有無を見ないため、PI_MODEL の指定も getAvailable() と突き合わせる。
  const matchAvailable = (ref: ModelRef): PiAiModel<Api> | undefined =>
    availableModelList.find((model) => model.provider === ref.provider && model.id === ref.id);
  let selectedModel = requested ? matchAvailable(requested.model) : availableModelList[0];
  let defaultModelError: string | undefined;
  if (requested && !selectedModel) {
    // 利用不能でも他候補へ黙ってフォールバックせず、ready のままエラーとして伝える。
    defaultModelError = `指定された既定モデルは利用できません: ${requested.model.provider}/${requested.model.id}`;
  }

  if (!selectedModel && !defaultModelError && !availabilityError) {
    const requestedProvider = requested?.model.provider;
    const hasConfiguredProvider = requestedProvider
      ? modelRuntime.getProviderAuthStatus(requestedProvider).configured
      : modelRuntime.getProviders().some(
          (provider) => modelRuntime.getProviderAuthStatus(provider.id).configured,
        );
    availabilityError = hasConfiguredProvider ? MODEL_UNAVAILABLE_MESSAGE : AUTH_REQUIRED_MESSAGE;
  }

  const defaultThinkingLevel = parseThinkingLevel(
    requested?.thinkingLevel ?? process.env.PI_THINKING?.trim() ?? "medium",
  );

  const modelOptions = availableModelList.map((model) => modelOptionOf(model));
  const resolveModel = (model: ModelRef): PiAiModel<Api> | undefined =>
    availableModelList.find(
      (candidate) => candidate.provider === model.provider && candidate.id === model.id,
    );

  async function createSession({
    agent,
    skills = [],
    model,
    thinkingLevel,
  }: CreateSessionInput = {}): Promise<{ session: unknown }> {
    // 明示されたモデルは利用可能一覧と厳密照合する
    const modelObject = model ? resolveModel(model) : selectedModel;
    if (model && !modelObject) {
      const error = new Error(
        `Model is not available: ${model.provider}/${model.id}`,
      ) as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    if (!modelObject) {
      const error = new Error(
        defaultModelError || availabilityError || AUTH_REQUIRED_MESSAGE,
      ) as Error & { statusCode?: number };
      error.statusCode = 503;
      throw error;
    }
    if (!sandboxClient) {
      const error = new Error(SANDBOX_NOT_CONFIGURED_MESSAGE) as Error & { statusCode?: number };
      error.statusCode = 503;
      throw error;
    }
    // セッションを使い捨てに保つ: JSONL セッションファイルを作らず、ユーザーの pi 設定にも書き込まない。
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
    });
    const agentPrompt = agent
      ? [
          `<agent_profile name="${agent.name}">`,
          agent.description,
          agent.systemPrompt,
          "</agent_profile>",
        ].filter(Boolean).join("\n")
      : "";
    const skillPrompts = skills
      .filter((skill) => skill && skill.name && skill.prompt)
      .map((skill) => `<skill name="${skill.name}">\n${skill.prompt}\n</skill>`);

    const resourceLoader = new DefaultResourceLoader({
      cwd: projectCwd,
      agentDir,
      settingsManager,
      // Web には拡張ダイアログに答える TUI が無いため決定論を優先し、noExtensions でも
      // 読み込まれる extensionFactories だけをインターフェイスにする。
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [createSecretRedactionExtension(secretMasker)],
      appendSystemPrompt: [APPEND_SYSTEM_PROMPT, agentPrompt, ...skillPrompts].filter(Boolean),
    });
    await resourceLoader.reload();

    const options: CreateAgentSessionOptions = {
      cwd: projectCwd,
      agentDir,
      modelRuntime,
      model: modelObject,
      thinkingLevel: (thinkingLevel ?? defaultThinkingLevel) as CreateAgentSessionOptions["thinkingLevel"],
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(projectCwd),
      tools: configuredTools(),
      // 組込み定義を「サンドボックスの実行API を呼ぶリモート定義」で置き換え、BFF 上で作業コードを実行しない。
      customTools: createRemoteToolDefinitions({
        cwd: projectCwd,
        client: sandboxClient,
        masker: secretMasker,
        tools: configuredTools(),
      }),
    };

    return createAgentSession(options);
  }

  return {
    cwd: projectCwd,
    agentDir,
    modelRuntime,
    selectedModel,
    availableModels,
    modelOptions,
    defaultThinkingLevel,
    defaultModelError,
    availabilityError,
    modelWhitelistExcludesAll,
    sandboxConfigured: Boolean(sandboxClient),
    tools: configuredTools(),
    resolveModel,
    createSession,
    modelLabel,
    secretMasker,
  };
}
