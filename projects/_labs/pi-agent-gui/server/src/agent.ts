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
import { join, resolve } from "node:path";
import type { AgentDef, SkillDef } from "./schema";

export interface PiModelRef {
  provider: string;
  id: string;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const APPEND_SYSTEM_PROMPT = `
You are running inside a very small browser UI backed by the pi SDK.
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
}

export interface PiBff {
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  selectedModel: PiModelRef | undefined;
  availableModels: PiModelRef[];
  availabilityError: string | undefined;
  tools: string[];
  createSession(input?: CreateSessionInput): Promise<{ session: unknown }>;
  modelLabel(model?: PiModelRef | null): string | undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseModelReference(
  runtime: ModelRuntime,
): { model: CreateAgentSessionOptions["model"]; thinkingLevel: string | undefined } {
  const rawValue = process.env.PI_MODEL?.trim();
  if (!rawValue) {
    return { model: undefined, thinkingLevel: undefined };
  }

  let reference = rawValue;
  let thinkingLevel = process.env.PI_THINKING?.trim() || undefined;
  const thinkingSuffix = reference.match(/:(off|minimal|low|medium|high|xhigh|max)$/);
  if (thinkingSuffix) {
    reference = reference.slice(0, -thinkingSuffix[0].length);
    thinkingLevel = thinkingSuffix[1];
  }

  if (thinkingLevel && !THINKING_LEVELS.has(thinkingLevel)) {
    throw new Error(`Invalid PI_THINKING value: ${thinkingLevel}`);
  }

  const slash = reference.indexOf("/");
  const provider = slash === -1 ? process.env.PI_PROVIDER?.trim() : reference.slice(0, slash);
  const modelId = slash === -1 ? reference : reference.slice(slash + 1);
  if (!provider || !modelId) {
    throw new Error("PI_MODEL must look like provider/model (or set PI_PROVIDER too)");
  }

  const model = runtime.getModel(provider, modelId);
  if (!model) {
    throw new Error(`Model not found: ${provider}/${modelId}`);
  }
  return { model, thinkingLevel };
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

  const requested = parseModelReference(modelRuntime);
  let selectedModel = requested.model;
  let availableModels: PiModelRef[] = [];
  let availabilityError: string | undefined;

  try {
    availableModels = [...await modelRuntime.getAvailable()];
    if (!selectedModel) selectedModel = availableModels[0] as CreateAgentSessionOptions["model"];
  } catch (error) {
    availabilityError = errorMessage(error);
  }

  const thinkingLevel = requested.thinkingLevel || process.env.PI_THINKING?.trim() || "medium";
  if (!THINKING_LEVELS.has(thinkingLevel)) {
    throw new Error(`Invalid PI_THINKING value: ${thinkingLevel}`);
  }

  async function createSession({ agent, skills = [] }: CreateSessionInput = {}): Promise<{ session: unknown }> {
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
      thinkingLevel: thinkingLevel as CreateAgentSessionOptions["thinkingLevel"],
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(projectCwd),
      tools: configuredTools(),
    };
    if (selectedModel) options.model = selectedModel;

    return createAgentSession(options);
  }

  return {
    cwd: projectCwd,
    agentDir,
    modelRuntime,
    selectedModel,
    availableModels,
    availabilityError,
    tools: configuredTools(),
    createSession,
    modelLabel,
  };
}
