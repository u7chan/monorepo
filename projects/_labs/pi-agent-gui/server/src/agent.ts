/**
 * プロセス全体で共有する pi ランタイムと、隔離されたインメモリ
 * セッションのファクトリ。認証はあえて pi の通常の認証解決
 * (auth.json, OAuth, プロバイダの環境変数) に委ねる。
 * port 元: src/agent.js
 */
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
import type { AgentDef, ModelOption, ModelRef, SkillDef, ThinkingLevel } from "./schema";

export interface PiModelRef {
  provider: string;
  id: string;
}

/** UI にそのまま表示できる、認証未設定時の案内。 */
export const AUTH_REQUIRED_MESSAGE =
  "APIキーが未設定です。ANTHROPIC_API_KEY などのプロバイダー用キーを設定するか、保存済みの認証情報を確認してからサーバーを再起動してください。";

const MODEL_UNAVAILABLE_MESSAGE =
  "利用可能なモデルがありません。既定モデルまたはプロバイダーの設定を確認してください。";

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
  /** 解決済みのモデル指定 (未指定ならアプリ既定) */
  model?: ModelRef;
  /** 解決済みの thinkingLevel (未指定ならアプリ既定) */
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
  /** アプリ既定の thinkingLevel (PI_MODEL 末尾指定 → PI_THINKING → medium) */
  defaultThinkingLevel: ThinkingLevel;
  /** 明示 PI_MODEL が利用不能なときの理由 (他候補があれば ready のまま) */
  defaultModelError: string | undefined;
  availabilityError: string | undefined;
  tools: string[];
  /** availableModels に厳密一致した SDK のモデルを返す (なければ undefined) */
  resolveModel(model: ModelRef): CreateAgentSessionOptions["model"] | undefined;
  createSession(input?: CreateSessionInput): Promise<{ session: unknown }>;
  modelLabel(model?: PiModelRef | null): string | undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** thinkingLevel 文字列を検証する (未知の段階は設定ミスとして例外) */
function parseThinkingLevel(value: string): ThinkingLevel {
  const parsed = ThinkingLevelSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Effort の値が不正です: ${value}`);
  return parsed.data;
}

/**
 * PI_MODEL / PI_THINKING を構文解釈する。
 * モデルの存在確認は行わない (利用可能一覧との照合は createPiBff 側)。
 * 構文不正や未知の thinkingLevel は設定ミスとして例外にする。
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

/** SDK の公開ヘルパーから picker 用の能力情報を作る (BFF 側で模倣しない) */
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

  const requested = parseModelReference();
  let availableModelList: PiAiModel<Api>[] = [];
  let availabilityError: string | undefined;

  try {
    availableModelList = [...await modelRuntime.getAvailable()];
  } catch (error) {
    availabilityError = errorMessage(error);
  }
  const availableModels: PiModelRef[] = availableModelList;

  // getModel() は認証の有無を確認しないため、PI_MODEL で指定したモデルも
  // getAvailable() の結果と突き合わせてから実行可能とみなす。
  const matchAvailable = (ref: ModelRef): PiAiModel<Api> | undefined =>
    availableModelList.find((model) => model.provider === ref.provider && model.id === ref.id);
  let selectedModel = requested ? matchAvailable(requested.model) : availableModelList[0];
  let defaultModelError: string | undefined;
  if (requested && !selectedModel) {
    // 明示 PI_MODEL が利用不能でも、他候補があれば別モデルへ黙って
    // フォールバックせず、ready のままエラーとして伝える。
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
    // 明示されたモデルは利用可能一覧と厳密照合し、SDK 作成前に拒否する。
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
    // セッションを使い捨てに保つ: JSONL セッションファイルを作らず、
    // ユーザーの pi 設定にも書き込まない。共有の ModelRuntime は
    // 通常の pi 認証を読むだけ。
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
      // Web アプリには拡張ダイアログに答える TUI がない。この
      // プロトタイプは決定論的に保ち、独自の prompt/tools だけを
      // インターフェイスにする。
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
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
    tools: configuredTools(),
    resolveModel,
    createSession,
    modelLabel,
  };
}
