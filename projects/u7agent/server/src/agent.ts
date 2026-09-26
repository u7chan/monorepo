/** pi ランタイムと SDK セッションのファクトリ。認証はあえて pi の通常の解決 (auth.json / OAuth / プロバイダー環境変数) に委ねる。 */
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
  type CreateAgentSessionOptions,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, Model as PiAiModel } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { COMMON_SKILLS_DIR } from "./app-paths";
import { catalogSkillIndexForSession } from "./catalog-skills";
import { discoverSessionFileSkills } from "./file-skills";
import { resolveWorkspaceCwd } from "./projects";
import { ThinkingLevelSchema } from "./schema";
import { createSandboxToolClientFromEnv } from "./sandbox/client";
import { createRemoteToolDefinitions } from "./sandbox/remote-tools";
import { createMutableSecretMasker, type SecretMasker } from "./redact";
import { collectSecretValues, createSecretRedactionExtension, extraSecretVarNames } from "./secret-guard";
import { catalogSkillsFromSnapshot } from "./session-skills";
import type {
  AgentDef,
  AgentSkillInfo,
  ModelOption,
  ModelRef,
  ModelReferenceDiagnostic,
  RuntimeAuth,
  RuntimeDiagnosticSummary,
  RuntimeModelsResponse,
  RuntimeVersions,
  SkillDef,
  ThinkingLevel,
} from "./schema";
import type { PromptSnapshot } from "./session-store";

export interface PiModelRef {
  provider: string;
  id: string;
}

export interface RuntimeModelDiagnostics {
  summary: RuntimeDiagnosticSummary;
  catalog: RuntimeModelsResponse;
}

export const AUTH_REQUIRED_MESSAGE =
  "APIキーが未設定です。設定 → モデル でプロバイダーのAPIキーを登録するか、ANTHROPIC_API_KEY などのプロバイダー用キーを設定してからサーバーを再起動してください。";

export const SANDBOX_NOT_CONFIGURED_MESSAGE =
  "サンドボックスが設定されていません。PI_SANDBOX_URL と PI_SANDBOX_TOKEN を設定してサーバーを再起動してください (ローカルでのツール実行にはフォールバックしません)。";

const MODEL_UNAVAILABLE_MESSAGE =
  "利用可能なモデルがありません。既定モデルまたはプロバイダーの設定を確認してください。";

export const MODEL_WHITELIST_EMPTY_MESSAGE =
  "PI_MODELS に指定したモデルが利用可能なモデルにありません。PI_MODELS の指定とプロバイダーの認証設定を確認してください。";

/**
 * セッション共通の追加プロンプト。作業ディレクトリの意味とファイル / スキルの置き場はセッションの cwd で
 * 変わるため rootCwd を受けて組み立てる (promptSnapshot に含めず、作成・復元のたびに評価する)。
 */
export function appendSystemPrompt(rootCwd: string): string {
  return `
You are running inside a small browser UI.
Respond in Japanese by default, unless the user asks for another language.
Keep answers practical and concise.
The working directory is the registered project directory for a project session, or a per-session scratch directory for a standalone chat.
Write and edit files with paths relative to the working directory (for example, \`cafe.html\`). Absolute paths outside the working directory are refused, except for the common skills directory.
User messages may reference files by an \`@<path>\` mention, or \`@"<path>"\` when the path contains spaces or quotes. Treat the path as relative to the working directory and open the referenced files with \`read\` when they matter.
Save downloaded or generated files in the working directory.

Environment: the tools run in a dedicated sandbox, not in the user's editor process.
In deployment it is a non-root Linux container where apt-get install fails.

Networking: use curl for HTTP(S) (e.g. \`curl -fsSL -o <path> <url>\`).
Prefer curl over one-off \`node -e\` fetch scripts; use node fetch only as a fallback when curl is missing.
In the deployed container: node 24, npm/npx, git, ripgrep (rg), fd, tar/gzip, unzip, zip, jq, file, xz, openssl, python 3.13, uv.
Not installed there: wget, ffmpeg, imagemagick.

Python: keep dependencies inside the working directory. Create the environment at \`.venv\` directly under it (\`uv venv .venv\`) and install packages with \`uv pip install --python .venv/bin/python <package>\`; \`python3 -m venv .venv\` also works and \`uv venv --seed\` adds pip. Do not install into the system area (PEP 668 and the non-root user refuse it).

When a task involves the project, inspect it with the available tools instead of guessing.
When the user asks to create or change a reusable skill, put it in the \`.agents/skills\` directory under the working directory, or in \`${join(rootCwd, COMMON_SKILLS_DIR)}\` for a standalone chat, and follow the bundled \`skill-creator\` skill for the location, layout, frontmatter and verification.
Do not reveal private chain-of-thought; provide a short useful summary of your reasoning instead.
`.trim();
}

const DEFAULT_TOOLS =
  process.platform === "win32"
    ? ["read", "powershell", "edit", "write", "grep", "find", "ls"]
    : ["read", "bash", "edit", "write", "grep", "find", "ls"];

export interface CreateSessionInput {
  agent?: AgentDef;
  skills?: SkillDef[];
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
  /** rootCwd 相対。省略・空文字は root */
  cwd?: string;
  /** 復元時: アプリのセッション ID (SDK の inMemory セッションへ渡す) */
  sessionId?: string;
  /** 復元時: JSONL から読んだ entries (header は含めない) */
  entries?: unknown[];
  /** 復元時: 作成時のプロンプトスナップショット。無ければ agent / skills から組む */
  promptSnapshot?: PromptSnapshot;
  /** セッションのエージェントスナップショット (カタログスキルの説明の出所。復元でも渡す) */
  agentSkills?: AgentSkillInfo[];
}

/**
 * 作成時の agent / skill スナップショット。agent は appendSystemPrompt へ入れる。skills は本文の出所
 * (`read` と `/skill:` の展開) で、system prompt へは入れない — 索引だけを skillsOverride で渡し、
 * 本文は必要時に読ませる。定義を編集・削除しても復元後の本文を変えないため meta へ保存する。
 */
export function composePromptSnapshot(agent?: AgentDef, skills: SkillDef[] = []): PromptSnapshot {
  const agentPrompt = agent
    ? [`<agent_profile name="${agent.name}">`, agent.description, agent.systemPrompt, "</agent_profile>"]
        .filter(Boolean)
        .join("\n")
    : "";
  const skillPrompts = skills
    .filter((skill) => skill && skill.name && skill.body)
    .map((skill) => `<agent_skill name="${skill.name}">\n${skill.body}\n</agent_skill>`);
  return { agent: agentPrompt, skills: skillPrompts };
}

export interface PiBff {
  /** ワークスペース root の絶対パス (サンドボックスの rootCwd と同じパスを指す契約) */
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  selectedModel: PiModelRef | undefined;
  availableModels: PiModelRef[];
  modelOptions: ModelOption[];
  defaultThinkingLevel: ThinkingLevel;
  /** 明示 PI_MODEL が利用不能なときの理由 (他候補があれば ready のまま) */
  defaultModelError: string | undefined;
  availabilityError: string | undefined;
  /** PI_MODELS が候補を全部落とした (ready: false の原因が whitelist だと health が判定するため) */
  modelWhitelistExcludesAll: boolean;
  /** whitelist 適用前のランタイム診断。取得に失敗しても既存のモデル選択には影響させない */
  runtimeDiagnostics: RuntimeModelDiagnostics | undefined;
  sandboxConfigured: boolean;
  tools: string[];
  resolveModel(model: ModelRef): CreateAgentSessionOptions["model"] | undefined;
  createSession(input?: CreateSessionInput): Promise<{ session: unknown; promptSnapshot: PromptSnapshot }>;
  modelLabel(model?: PiModelRef | null): string | undefined;
  secretMasker: SecretMasker;
  /**
   * 実行中に得た秘密値 (GUI 入力のAPIキー・DB から読んだキー) を保護対象へ足す。
   * 同じ値の再登録は no-op で、プロセス生存中は集合から取り除かない。
   */
  retainSecret(value: string): void;
  /** SDK のモデル状態を読み直して公開 state を差し替える。throw しない (lock を壊さない) */
  refreshModelState(): Promise<void>;
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
export function parseModelReference(
  env: NodeJS.ProcessEnv = process.env,
): { model: ModelRef; thinkingLevel: ThinkingLevel | undefined } | undefined {
  const rawValue = env.PI_MODEL?.trim();
  if (!rawValue) {
    return undefined;
  }

  let reference = rawValue;
  let thinkingLevel = env.PI_THINKING?.trim() || undefined;
  const thinkingSuffix = reference.match(/:(off|minimal|low|medium|high|xhigh|max)$/);
  if (thinkingSuffix) {
    reference = reference.slice(0, -thinkingSuffix[0].length);
    thinkingLevel = thinkingSuffix[1];
  }

  const parsedLevel = thinkingLevel === undefined ? undefined : parseThinkingLevel(thinkingLevel);

  const slash = reference.indexOf("/");
  const provider = slash === -1 ? env.PI_PROVIDER?.trim() : reference.slice(0, slash);
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
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
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
export function filterModelsByWhitelist(models: PiAiModel<Api>[], whitelist: ModelRef[] | undefined): PiAiModel<Api>[] {
  if (!whitelist) return models;
  return models.filter((model) => whitelist.some((ref) => ref.provider === model.provider && ref.id === model.id));
}

export interface RuntimeAuthStatusLike {
  configured: boolean;
  source?: string;
  label?: string;
}

const AUTH_SOURCES = new Set([
  "environment",
  "stored",
  "runtime",
  "fallback",
  "models_json_key",
  "models_json_command",
]);
const ENVIRONMENT_VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** AuthStatus.label は任意文字列なので公開せず、環境変数名として検証できたものだけを残す。 */
export function sanitizeRuntimeAuth(status: RuntimeAuthStatusLike | undefined): RuntimeAuth {
  const configured = status?.configured ?? false;
  const source =
    configured && status?.source
      ? AUTH_SOURCES.has(status.source)
        ? (status.source as RuntimeAuth["source"])
        : "unknown"
      : undefined;
  const environmentVariables =
    source === "environment" && typeof status?.label === "string"
      ? [
          ...new Set(
            status.label
              .split(",")
              .map((name) => name.trim())
              .filter((name) => ENVIRONMENT_VARIABLE_NAME.test(name)),
          ),
        ]
      : [];
  return {
    configured,
    ...(source ? { source } : {}),
    environmentVariables,
  };
}

export function runtimeVersionInfo(env: NodeJS.ProcessEnv = process.env): RuntimeVersions {
  let piAi: string | undefined;
  try {
    const packageJsonUrl = new URL("../package.json", import.meta.resolve("@earendil-works/pi-ai"));
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as { version?: unknown };
    if (typeof packageJson.version === "string") piAi = packageJson.version;
  } catch {
    // pi-ai has no public version export; dist/package.json may be unavailable in alternate package layouts.
  }
  const commitHash = env.COMMIT_HASH?.trim() || undefined;
  return {
    piCodingAgent: VERSION,
    ...(piAi ? { piAi } : {}),
    ...(commitHash ? { commitHash } : {}),
  };
}

export interface RuntimeDiagnosticInput {
  catalog: readonly PiAiModel<Api>[];
  available: readonly PiAiModel<Api>[];
  providerIds: readonly string[];
  authStatuses: ReadonlyMap<string, RuntimeAuthStatusLike>;
  whitelist: ModelRef[] | undefined;
  requestedModel: ModelRef | undefined;
  versions: RuntimeVersions;
}

const modelKey = ({ provider, id }: ModelRef): string => JSON.stringify([provider, id]);

/** Purely derives safe diagnostics from the model runtime snapshot; picker inputs are left untouched. */
export function deriveRuntimeModelDiagnostics(input: RuntimeDiagnosticInput): RuntimeModelDiagnostics {
  const { catalog, available, providerIds, authStatuses, whitelist, requestedModel, versions } = input;
  const catalogByKey = new Map(catalog.map((model) => [modelKey(model), model]));
  const catalogKeys = new Set(catalogByKey.keys());
  const availableKeys = new Set(available.map(modelKey));
  const providerSet = new Set(providerIds);
  const whitelistConfigured = whitelist !== undefined;
  const isInWhitelist = (ref: ModelRef) =>
    !whitelistConfigured || whitelist.some((entry) => entry.provider === ref.provider && entry.id === ref.id);

  const diagnose = (ref: ModelRef): ModelReferenceDiagnostic => {
    const key = modelKey(ref);
    const cataloged = catalogKeys.has(key);
    const authenticated = sanitizeRuntimeAuth(authStatuses.get(ref.provider)).configured;
    const availableModel = availableKeys.has(key);
    const inWhitelist = isInWhitelist(ref);
    const status = !providerSet.has(ref.provider)
      ? "unknown_provider"
      : !cataloged
        ? "catalog_missing"
        : !authenticated
          ? "unauthenticated"
          : !inWhitelist
            ? "not_in_whitelist"
            : availableModel
              ? "available"
              : "not_available";
    return { ...ref, status, cataloged, authenticated, available: availableModel, inWhitelist };
  };

  const distinctCatalog = new Map(catalog.map((model) => [modelKey(model), model]));
  const whitelistCount = [...distinctCatalog.keys()].filter((key) => {
    const model = distinctCatalog.get(key);
    return model ? isInWhitelist(model) : false;
  }).length;
  const uniqueProviders = [...new Set(providerIds)];
  const countFor = (provider: string) => {
    const models = catalog.filter((model) => model.provider === provider);
    const distinctModels = new Map(models.map((model) => [modelKey(model), model]));
    return {
      catalogCount: models.length,
      whitelistCount: [...distinctModels.values()].filter(isInWhitelist).length,
      availableCount: available.filter((model) => model.provider === provider).length,
    };
  };
  const toProvider = (provider: string) => ({
    provider,
    auth: sanitizeRuntimeAuth(authStatuses.get(provider)),
    models: catalog
      .filter((model) => model.provider === provider)
      .map((model) => ({
        id: model.id,
        name: model.name || `${model.provider}/${model.id}`,
        available: availableKeys.has(modelKey(model)),
        inWhitelist: isInWhitelist(model),
      })),
  });

  const referencedProviders = new Set(
    [requestedModel, ...(whitelist ?? [])]
      .filter((ref): ref is ModelRef => ref !== undefined)
      .map((ref) => ref.provider),
  );
  const summaryProviderIds = [
    ...uniqueProviders.filter(
      (provider) => sanitizeRuntimeAuth(authStatuses.get(provider)).configured || referencedProviders.has(provider),
    ),
    ...[...referencedProviders].filter((provider) => !providerSet.has(provider)),
  ];
  const providers = summaryProviderIds.map((provider) => ({
    provider,
    auth: sanitizeRuntimeAuth(authStatuses.get(provider)),
    ...countFor(provider),
  }));
  const piModels = (whitelist ?? []).map(diagnose);
  const summary: RuntimeDiagnosticSummary = {
    status: "available",
    whitelistConfigured,
    catalogCount: catalog.length,
    whitelistCount,
    availableCount: available.length,
    ...(requestedModel ? { piModel: diagnose(requestedModel) } : {}),
    piModels,
    providers,
    versions,
  };
  const response: RuntimeModelsResponse = {
    whitelistConfigured,
    catalogCount: catalog.length,
    whitelistCount,
    availableCount: available.length,
    versions,
    providers: uniqueProviders.map(toProvider),
  };
  return { summary, catalog: response };
}

export function unavailableRuntimeDiagnostics(
  unavailableReason: "runtime_unavailable" | "diagnostics_unavailable",
): RuntimeDiagnosticSummary {
  return { status: "unavailable", unavailableReason, versions: runtimeVersionInfo() };
}

/** SDK から読んだランタイムのスナップショット (非同期・失敗しうる)。公開 state はここから純粋に導出する。 */
export interface ModelSnapshot {
  /** whitelist 適用前の利用可能モデル */
  available: PiAiModel<Api>[];
  catalog: PiAiModel<Api>[];
  providerIds: string[];
  authStatuses: Map<string, RuntimeAuthStatusLike>;
  /** getAvailable() 失敗時のみ。値は必ずマスク済み */
  availabilityError?: string;
}

/** health / resolveModel / ピッカーが読む公開 state。常にミューテーションロックの内側で 1 参照だけ差し替える。 */
export interface ModelState {
  availableModels: PiAiModel<Api>[];
  modelOptions: ModelOption[];
  selectedModel?: PiAiModel<Api>;
  defaultModelError?: string;
  availabilityError?: string;
  modelWhitelistExcludesAll: boolean;
  runtimeDiagnostics?: RuntimeModelDiagnostics;
}

/** 可用 0 の安全な state。導出そのものが失敗したときだけ使う (古い可用一覧を成功として残さない) */
export function unavailableModelState(availabilityError?: string): ModelState {
  return {
    availableModels: [],
    modelOptions: [],
    modelWhitelistExcludesAll: false,
    ...(availabilityError ? { availabilityError } : {}),
  };
}

export async function readModelSnapshot(modelRuntime: ModelRuntime): Promise<ModelSnapshot> {
  const available = [...(await modelRuntime.getAvailable())];
  const providerIds = modelRuntime.getProviders().map((provider) => provider.id);
  const authStatuses = new Map(
    providerIds.map((provider) => [provider, modelRuntime.getProviderAuthStatus(provider)] as const),
  );
  return { available, catalog: [...modelRuntime.getModels()], providerIds, authStatuses };
}

export interface ModelStateInput {
  snapshot: ModelSnapshot;
  requested: RequestedModel | undefined;
  whitelist: ModelRef[] | undefined;
  versions: RuntimeVersions;
}

/** PI_MODEL の構文解釈結果 (requested。thinkingLevel はここでは使わない) */
export interface RequestedModel {
  model: ModelRef;
  thinkingLevel: ThinkingLevel | undefined;
}

/**
 * スナップショット読取から公開 state までを 1 回分行う。非同期の失敗 (SDK) も導出の失敗 (バグ・契約外データ)
 * も例外にせず、可用 0 の安全な state へ寄せる。
 */
export async function readModelState(input: {
  modelRuntime: ModelRuntime;
  requested: RequestedModel | undefined;
  whitelist: ModelRef[] | undefined;
  versions: RuntimeVersions;
  /** health / availabilityError に出るため、SDK の例外文言はここで必ずマスクする */
  maskError: (error: unknown) => string;
}): Promise<ModelState> {
  let snapshot: ModelSnapshot;
  try {
    snapshot = await readModelSnapshot(input.modelRuntime);
  } catch (error) {
    let catalog: PiAiModel<Api>[] = [];
    try {
      catalog = [...input.modelRuntime.getModels()];
    } catch {
      // カタログも読めないときは空のまま (診断は unavailable になる)
    }
    snapshot = {
      available: [],
      catalog,
      providerIds: [],
      authStatuses: new Map(),
      availabilityError: input.maskError(error),
    };
  }
  try {
    return deriveModelState({
      snapshot,
      requested: input.requested,
      whitelist: input.whitelist,
      versions: input.versions,
    });
  } catch {
    return unavailableModelState("モデル状態の再計算に失敗しました");
  }
}

/**
 * スナップショットから公開 state を純粋に導出する。可用モデルの絞り込み・既定モデルの選択・
 * 診断の集計を 1 箇所に閉じ、すべての値が同じ available から決まるようにする。
 */
export function deriveModelState({ snapshot, requested, whitelist, versions }: ModelStateInput): ModelState {
  const availableModelList = filterModelsByWhitelist(snapshot.available, whitelist);
  let availabilityError = snapshot.availabilityError;
  let modelWhitelistExcludesAll = false;
  if (whitelist && !availabilityError && availableModelList.length === 0) {
    // 認証が未設定でも whitelist は必ず空になるため、対処先を絞れるよう両方を確認させる文言で返す。
    modelWhitelistExcludesAll = true;
    availabilityError = MODEL_WHITELIST_EMPTY_MESSAGE;
  }

  // getModel() は認証の有無を見ないため、PI_MODEL の指定も getAvailable() と突き合わせる。
  const selectedModel = requested
    ? availableModelList.find((model) => model.provider === requested.model.provider && model.id === requested.model.id)
    : availableModelList[0];
  let defaultModelError: string | undefined;
  if (requested && !selectedModel) {
    // 利用不能でも他候補へ黙ってフォールバックせず、ready のままエラーとして伝える。
    defaultModelError = `指定された既定モデルは利用できません: ${requested.model.provider}/${requested.model.id}`;
  }

  if (!selectedModel && !defaultModelError && !availabilityError) {
    const requestedProvider = requested?.model.provider;
    const hasConfiguredProvider = requestedProvider
      ? sanitizeRuntimeAuth(snapshot.authStatuses.get(requestedProvider)).configured
      : snapshot.providerIds.some((provider) => sanitizeRuntimeAuth(snapshot.authStatuses.get(provider)).configured);
    availabilityError = hasConfiguredProvider ? MODEL_UNAVAILABLE_MESSAGE : AUTH_REQUIRED_MESSAGE;
  }

  let runtimeDiagnostics: RuntimeModelDiagnostics | undefined;
  if (!snapshot.availabilityError) {
    try {
      runtimeDiagnostics = deriveRuntimeModelDiagnostics({
        catalog: snapshot.catalog,
        available: snapshot.available,
        providerIds: snapshot.providerIds,
        authStatuses: snapshot.authStatuses,
        whitelist,
        requestedModel: requested?.model,
        versions,
      });
    } catch {
      // Diagnostics are best-effort and must not change the existing runtime or model-selection behavior.
    }
  }

  return {
    availableModels: availableModelList,
    modelOptions: availableModelList.map(modelOptionOf),
    selectedModel,
    defaultModelError,
    availabilityError,
    modelWhitelistExcludesAll,
    runtimeDiagnostics,
  };
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
  const tools = value
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : DEFAULT_TOOLS;
}

/** SDK の compaction の既定値 (SettingsManager と同じ) */
const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384;
const DEFAULT_COMPACTION_KEEP_RECENT_TOKENS = 20_000;

/**
 * compaction の閾値を下げて発火させやすくする検証用の環境変数を読む。
 * 未設定・不正値 (0 以下・非整数・非数値) は undefined を返し、SDK 既定のままにする (デプロイ影響なし)。
 */
export function parseCompactionTokenKnob(raw: string | undefined): number | undefined {
  const value = Number(raw?.trim());
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export function compactionSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): {
  enabled: true;
  reserveTokens: number;
  keepRecentTokens: number;
} {
  return {
    enabled: true,
    reserveTokens: parseCompactionTokenKnob(env.PI_COMPACTION_RESERVE_TOKENS) ?? DEFAULT_COMPACTION_RESERVE_TOKENS,
    keepRecentTokens:
      parseCompactionTokenKnob(env.PI_COMPACTION_KEEP_RECENT_TOKENS) ?? DEFAULT_COMPACTION_KEEP_RECENT_TOKENS,
  };
}

function modelLabel(model?: PiModelRef | null): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

export interface SessionResourceLoaderInput {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  secretMasker: SecretMasker;
  appendSystemPrompt: string[];
  /** サンドボックスで発見済みのファイルスキル。skillsOverride で SDK の一覧へ足す */
  fileSkills?: Skill[];
  /** カタログ (Agent 割り当て) スキルの索引。本文は持たず、仮想パスを read させる */
  catalogSkills?: Skill[];
}

/**
 * セッションの resource loader。`.pi` / `~/.pi/agent` を読ませないため noSkills は維持したまま、
 * 発見済みのファイルスキルを skillsOverride で注入する (ネイティブ発見・祖先さかのぼりは使わない)。
 */
export function createSessionResourceLoader(input: SessionResourceLoaderInput): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager: input.settingsManager,
    // Web には拡張ダイアログに答える TUI が無いため決定論を優先し、noExtensions でも
    // 読み込まれる extensionFactories だけをインターフェイスにする。
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [createSecretRedactionExtension(input.secretMasker)],
    appendSystemPrompt: input.appendSystemPrompt,
    skillsOverride: (base) => ({
      skills: [...base.skills, ...(input.fileSkills ?? []), ...(input.catalogSkills ?? [])],
      diagnostics: base.diagnostics,
    }),
  });
}

export async function createPiBff({ cwd = process.cwd() }: { cwd?: string } = {}): Promise<PiBff> {
  // rootCwd は「ワークスペース root」で、セッションごとの cwd はここからの相対パスで解決する。
  const rootCwd = resolve(cwd);
  const agentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  // 保護対象は BFF が環境変数で受け取ったキーの非空値だけで、認証に使う process.env 自体は変更しない。
  // 可変にして、GUI から登録されたキーを SDK / DB へ渡す前に保護対象へ足せるようにする。
  const secretMasker = createMutableSecretMasker(
    collectSecretValues(modelRuntime.getProviders(), process.env, extraSecretVarNames(process.env)),
  );
  // 削除・上書きしてもプロセス生存中は保護対象から外さない (raw の session.jsonl の再投影で旧キーを出さないため)。
  const retainedSecrets = new Set<string>();
  const retainSecret = (value: string): void => {
    if (typeof value !== "string" || value.trim() === "" || retainedSecrets.has(value)) return;
    retainedSecrets.add(value);
    secretMasker.setSecrets([
      ...collectSecretValues(modelRuntime.getProviders(), process.env, extraSecretVarNames(process.env)),
      ...retainedSecrets,
    ]);
  };
  // 作業用ツールはすべてサンドボックス (別プロセス) で実行し、BFF ローカル実行へはフォールバックしない。
  const sandboxClient = createSandboxToolClientFromEnv(process.env);

  const requested = parseModelReference();
  const modelWhitelist = parseModelWhitelist(process.env.PI_MODELS);
  const versions = runtimeVersionInfo();
  const maskError = (error: unknown): string => secretMasker.mask(errorMessage(error));

  const current = { value: unavailableModelState() };
  /** 公開 state の差し替え。ロックの内側でだけ呼び、例外は出さない (lock を壊さない)。 */
  async function refreshModelState(): Promise<void> {
    current.value = await readModelState({ modelRuntime, requested, whitelist: modelWhitelist, versions, maskError });
  }
  await refreshModelState();

  const defaultThinkingLevel = parseThinkingLevel(
    requested?.thinkingLevel ?? process.env.PI_THINKING?.trim() ?? "medium",
  );

  const resolveModel = (model: ModelRef): PiAiModel<Api> | undefined =>
    current.value.availableModels.find(
      (candidate) => candidate.provider === model.provider && candidate.id === model.id,
    );
  // 検証時だけ閾値を下げる。未設定なら SDK 既定 (16384 / 20000) で従来と同じ。
  const compactionSettings = compactionSettingsFromEnv();

  async function createSession({
    agent,
    skills = [],
    model,
    thinkingLevel,
    cwd: requestedCwd = "",
    sessionId,
    entries,
    promptSnapshot,
    agentSkills = [],
  }: CreateSessionInput = {}): Promise<{ session: unknown; promptSnapshot: PromptSnapshot }> {
    // 不正な cwd はモデル解決より先に 400 にする (実行できない指定を 503 の裏に隠さない)
    const { relative: relativeCwd, absolute: sessionCwd } = resolveWorkspaceCwd(rootCwd, requestedCwd);
    // 明示されたモデルは利用可能一覧と厳密照合する
    const modelObject = model ? resolveModel(model) : current.value.selectedModel;
    if (model && !modelObject) {
      const error = new Error(`Model is not available: ${model.provider}/${model.id}`) as Error & {
        statusCode?: number;
      };
      error.statusCode = 400;
      throw error;
    }
    if (!modelObject) {
      const error = new Error(
        current.value.defaultModelError || current.value.availabilityError || AUTH_REQUIRED_MESSAGE,
      ) as Error & {
        statusCode?: number;
      };
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
      compaction: compactionSettings,
      retry: { enabled: true, maxRetries: 2 },
    });
    const snapshot = promptSnapshot ?? composePromptSnapshot(agent, skills);
    // ファイルスキルは SDK のネイティブ発見を使わず、サンドボックスで発見した一覧を skillsOverride で渡す
    // (発見に失敗してもスキル無しでセッション作成を続行する)
    const fileSkills = await discoverSessionFileSkills(sandboxClient, { rootCwd, relativeCwd });
    // カタログスキルは索引 (name / description / location) だけを渡し、本文は promptSnapshot から
    // read / `/skill:` の展開が取り出す。ファイル / 組み込みと同名の行は索引からも落とす (一覧と一致)
    const catalogSkillBodies = catalogSkillsFromSnapshot(snapshot);
    const catalogIndex = catalogSkillIndexForSession(
      rootCwd,
      catalogSkillBodies,
      agentSkills,
      fileSkills.skills.map((skill) => skill.name),
    );
    const resourceLoader = createSessionResourceLoader({
      cwd: sessionCwd,
      agentDir,
      settingsManager,
      secretMasker,
      appendSystemPrompt: [appendSystemPrompt(rootCwd), snapshot.agent].filter(Boolean),
      fileSkills: fileSkills.skills,
      catalogSkills: catalogIndex,
    });
    await resourceLoader.reload();

    const options: CreateAgentSessionOptions = {
      cwd: sessionCwd,
      agentDir,
      modelRuntime,
      model: modelObject,
      thinkingLevel: (thinkingLevel ?? defaultThinkingLevel) as CreateAgentSessionOptions["thinkingLevel"],
      resourceLoader,
      settingsManager,
      // 会話の永続化は BFF (session-store) が担う。SDK 側はファイルを持たず、entries の入れ物として使う。
      sessionManager: SessionManager.inMemory(
        sessionCwd,
        sessionId ? { id: sessionId } : undefined,
        entries as Parameters<typeof SessionManager.inMemory>[2],
      ),
      tools: configuredTools(),
      // 組込み定義を「サンドボックスの実行API を呼ぶリモート定義」で置き換え、BFF 上で作業コードを実行しない。
      customTools: createRemoteToolDefinitions({
        cwd: sessionCwd,
        rootCwd,
        sandboxCwd: relativeCwd,
        client: sandboxClient,
        masker: secretMasker,
        tools: configuredTools(),
        catalogSkills: catalogSkillBodies,
      }),
    };

    return { session: (await createAgentSession(options)).session, promptSnapshot: snapshot };
  }

  return {
    cwd: rootCwd,
    agentDir,
    modelRuntime,
    get selectedModel() {
      return current.value.selectedModel;
    },
    get availableModels() {
      return current.value.availableModels;
    },
    get modelOptions() {
      return current.value.modelOptions;
    },
    defaultThinkingLevel,
    get defaultModelError() {
      return current.value.defaultModelError;
    },
    get availabilityError() {
      return current.value.availabilityError;
    },
    get modelWhitelistExcludesAll() {
      return current.value.modelWhitelistExcludesAll;
    },
    get runtimeDiagnostics() {
      return current.value.runtimeDiagnostics;
    },
    sandboxConfigured: Boolean(sandboxClient),
    tools: configuredTools(),
    resolveModel,
    createSession,
    modelLabel,
    secretMasker,
    retainSecret,
    refreshModelState,
  };
}
