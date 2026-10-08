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
import { createAskUserToolDefinitions, withAskUserTool, type AskUserHost } from "./ask-user-tool";
import { catalogSkillIndexForSession } from "./catalog-skills";
import { discoverSessionFileSkills } from "./file-skills";
import { createImageToolDefinitions, IMAGE_GENERATION_PROMPT_LINES, sessionToolNames } from "./image-tools";
import { createImagesGenerator, type ImageGenerationConfig } from "./images";
import { resolveWorkspaceCwd } from "./projects";
import { ThinkingLevelSchema } from "./schema";
import { createServeToolDefinitions, withServeTool, type ServeToolHost } from "./serve-tool";
import { createSandboxToolClientFromEnv } from "./sandbox/client";
import { createRemoteToolDefinitions } from "./sandbox/remote-tools";
import { createMutableSecretMasker, type SecretMasker } from "./redact";
import { DEFAULT_WEB_SEARCH_PROVIDER } from "./web-search-providers";
import { createWebSearchToolDefinitions, withWebSearchTool, type WebSearchRuntimeConfig } from "./web-search-tool";
import { collectSecretValues, createSecretRedactionExtension, extraSecretVarNames } from "./secret-guard";
import { catalogSkillsFromSnapshot } from "./session-skills";
import type {
  AgentDef,
  AgentSkillInfo,
  ModelOption,
  ModelRef,
  RuntimeAuth,
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

export const AUTH_REQUIRED_MESSAGE =
  "APIキーが未設定です。設定 → モデル でプロバイダーのAPIキーを登録するか、ANTHROPIC_API_KEY などのプロバイダー用キーを設定してからサーバーを再起動してください。";

export const SANDBOX_NOT_CONFIGURED_MESSAGE =
  "サンドボックスが設定されていません。PI_SANDBOX_URL と PI_SANDBOX_TOKEN を設定してサーバーを再起動してください (ローカルでのツール実行にはフォールバックしません)。";

const MODEL_UNAVAILABLE_MESSAGE =
  "利用可能なモデルがありません。設定 → モデル で利用可能なモデルとプロバイダーの認証を確認してください。";

export const MODEL_WHITELIST_EMPTY_MESSAGE =
  "利用可能なモデルが 1 つもありません。設定 → モデル で利用可能なモデルとプロバイダーの認証を確認してください。";

/**
 * 保存された既定モデルが無い状態。候補の先頭で代用すると契約で使えないモデルを勝手に選び、
 * 原因の分からない初回失敗を生むため、ここで止めて選択を促す。
 */
export const MODEL_UNSET_MESSAGE =
  "使用するモデルが未設定です。設定 → モデル で既定モデルを選ぶか、モデルを指定してから送信してください。";

/** 設定の入口を GUI へ移した後も process.env に残りうる、読み取らなくなった環境変数 */
export const IGNORED_MODEL_ENVIRONMENT_VARIABLES = ["PI_MODELS", "PI_MODEL", "PI_PROVIDER"] as const;

/** 残っている環境変数名を起動ログと設定画面の注記へ出す。空文字は「設定していない」と同じ扱い */
export function ignoredModelEnvironmentVariables(env: NodeJS.ProcessEnv = process.env): string[] {
  return IGNORED_MODEL_ENVIRONMENT_VARIABLES.filter((name) => env[name]?.trim());
}

/**
 * セッション共通の追加プロンプト。作業ディレクトリの意味とファイル / スキルの置き場はセッションの cwd で
 * 変わるため rootCwd を受けて組み立てる (promptSnapshot に含めず、作成・復元のたびに評価する)。
 * 画像生成の案内はツールを公開したセッションだけが受け取る (無効時に存在しないツールを案内しない)。
 */
export function appendSystemPrompt(rootCwd: string, options: { imageGeneration?: boolean } = {}): string {
  return `
You are running inside a small browser UI.
Respond in Japanese by default, unless the user asks for another language.
Keep answers practical and concise.
The working directory is the registered project directory for a project session, or a per-session scratch directory for a standalone chat.
Write and edit files with paths relative to the working directory (for example, \`cafe.html\`). Absolute paths outside the working directory are refused, except for the common skills directory.
When summarizing files, refer to files inside the working directory by cwd-relative path, but use their absolute paths for files under \`${join(rootCwd, COMMON_SKILLS_DIR)}\`; a cwd-relative path there points somewhere else.
User messages may reference files by an \`@<path>\` mention, or \`@"<path>"\` when the path contains spaces or quotes. Treat the path as relative to the working directory and open the referenced files with \`read\` when they matter.
Save downloaded or generated files in the working directory.

Environment: the tools run in a dedicated sandbox, not in the user's editor process.
In deployment it is a non-root Linux container where apt-get install fails.

Networking: use curl for HTTP(S) (e.g. \`curl -fsSL -o <path> <url>\`).
Prefer curl over one-off \`node -e\` fetch scripts; use node fetch only as a fallback when curl is missing.
In the deployed container: node 24, npm/npx, git, ripgrep (rg), fd, tar/gzip, unzip, zip, jq, file, xz, openssl, python 3.13, uv.
Not installed there: wget, ffmpeg, imagemagick.

To let the user inspect a served app in their browser, drive it with the \`serve\` tool (the UI calls it a service) and follow the bundled \`serve\` skill. The app must listen on 0.0.0.0:8080; only one app is served across all conversations, and starting replaces whatever is served now. Container recreation stops it, and the UI does not restore it.

Python: keep dependencies inside the working directory. Create the environment at \`.venv\` directly under it (\`uv venv .venv\`) and install packages with \`uv pip install --python .venv/bin/python <package>\`; \`python3 -m venv .venv\` also works and \`uv venv --seed\` adds pip. Do not install into the system area (PEP 668 and the non-root user refuse it).

When a task involves the project, inspect it with the available tools instead of guessing.
When the user asks to create or change a reusable skill, put it in the \`.agents/skills\` directory under the working directory, or in \`${join(rootCwd, COMMON_SKILLS_DIR)}\` for a standalone chat, and follow the bundled \`skill-creator\` skill for the location, layout, frontmatter and verification.
Do not reveal private chain-of-thought; provide a short useful summary of your reasoning instead.
${options.imageGeneration ? IMAGE_GENERATION_PROMPT_LINES.join("\n") : ""}
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
  /** 所有権の束縛に使う会話 id。永続化なしでも渡す (SDK の inMemory へ渡す id とは条件が違う) */
  ownerSessionId?: string;
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

/**
 * 設定 → モデル から保存された実効選択。allowedModels の undefined は制限なし、
 * defaultModel の undefined は「既定が未設定」で、候補の先頭では代用しない。
 * 保存の正はアプリ DB で、この値は `ModelSettingsService` が起動時と保存のたびに写す。
 */
export interface ModelSelection {
  allowedModels: ModelRef[] | undefined;
  defaultModel: ModelRef | undefined;
}

/**
 * エージェントの bash へ渡す「変数」の解決元 (作業フォルダ = cwd がキー)。
 * 値ではなく解決関数を渡すのは、変更を「次の bash」から反映させるため。
 */
export interface SessionEnvSource {
  variablesFor(cwd: string): Record<string, string>;
}

/**
 * カタログ更新の試行結果。provider ごとの失敗は件数だけを返し、内訳は応答にもログにも出さない
 * (どの provider が落ちたかは SDK の credential 解決に依存し、利用者の設定を写さないため)。
 */
export interface ModelCatalogRefreshAttempt {
  /** SDK が呼び出し元の signal で中断した (総時間の上限に当たった) */
  aborted: boolean;
  failedProviders: number;
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
  /** 保存された既定モデルが利用不能なときの理由 (他候補があれば ready のまま) */
  defaultModelError: string | undefined;
  /** 保存された既定モデルが無い (候補はある)。新規会話はモデル無指定では作れない */
  defaultModelUnset: boolean;
  availabilityError: string | undefined;
  /** 許可リストが候補を全部落とした (ready: false の原因が許可リストだと health が判定するため) */
  modelWhitelistExcludesAll: boolean;
  /** 許可リストを適用する前のカタログ。取得に失敗しても既存のモデル選択には影響させない */
  modelCatalog: RuntimeModelsResponse | undefined;
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
  /** 実効選択を差し替える。公開 state への反映は refreshModelState() が担う (setter → refresh の順) */
  setModelSelection(selection: ModelSelection): void;
  /**
   * SDK のモデル状態を読み直して公開 state を差し替える。throw しない (lock を壊さない)。
   * `signal` は SDK の読み取り (`getAvailable()` の認証ストア読み) へ伝え、期限切れの結果では差し替えない。
   */
  refreshModelState(options?: { signal?: AbortSignal }): Promise<void>;
  /**
   * pi.dev の provider 別カタログを取り直す。offline の判定と総時間の上限は呼び出し側 (設定サービス) が持ち、
   * ここは SDK の refresh へ写すだけ (例外は呼び出し側が固定文言へ寄せる)。
   */
  refreshModelCatalog(options: {
    allowNetwork: boolean;
    force: boolean;
    signal: AbortSignal;
  }): Promise<ModelCatalogRefreshAttempt>;
  /** 画像生成ツールを公開しているか。セッション作成時に読み、ツール一覧を固定する */
  imageGenerationEnabled: boolean;
  /**
   * 画像生成の設定を注入する。DB を正とする ImageSettingsService が同じロックの内側で呼び、
   * `read` は常に差し替える（既存セッションの execute は削除後も現在の行を見に行く）
   */
  setImageGeneration(config: ImageGenerationConfig): void;
  /**
   * `web_search` の実行時設定（有効 / 無効・既定 provider・provider のキー）を注入する。ツールは
   * execute のたびに読むため、既存セッションにも次の呼び出しから効く。設定が未注入の間は有効 / Exa
   */
  setWebSearch(config: WebSearchRuntimeConfig): void;
  /**
   * serve ツールの実体を注入する。bootstrap がアプリデータ (実績) とサンドボックスの両方を持つため、
   * ツール定義はこのホストへ委譲する (GUI と同じ ServeService を通る)
   */
  setServe(host: ServeToolHost): void;
  /**
   * ask_user ツールの実体を注入する。待機の所有は SessionStore が持ち、ツールはここの ask を await する
   */
  setAskUser(host: AskUserHost): void;
  /**
   * 作業フォルダの変数をエージェントの bash へ注入する。bootstrap がアプリデータ (secrets) を持つため、
   * 解決はこの源へ委譲する (シークレットはここへ入れない)
   */
  setSessionEnv(source: SessionEnvSource): void;
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
 * PI_THINKING を構文解釈する。既定 Effort はこの値 → medium の順で決まる。
 */
export function parseThinkingLevelFromEnv(env: NodeJS.ProcessEnv = process.env): ThinkingLevel {
  return parseThinkingLevel(env.PI_THINKING?.trim() ?? "medium");
}

/**
 * available と許可リストの積。availableModels / modelOptions / selectedModel / resolveModel は
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

export interface RuntimeCatalogInput {
  catalog: readonly PiAiModel<Api>[];
  available: readonly PiAiModel<Api>[];
  providerIds: readonly string[];
  authStatuses: ReadonlyMap<string, RuntimeAuthStatusLike>;
  versions: RuntimeVersions;
}

const modelKey = ({ provider, id }: ModelRef): string => JSON.stringify([provider, id]);

/**
 * カタログと available の対応を公開する。許可リストは設定 API (`allowedModels`) だけが持ち、
 * ここに同じ情報を残さない (画面と応答で「許可されているか」の正を 1 つにする)。
 */
export function deriveRuntimeCatalog(input: RuntimeCatalogInput): RuntimeModelsResponse {
  const { catalog, available, providerIds, authStatuses, versions } = input;
  const availableKeys = new Set(available.map(modelKey));
  return {
    catalogCount: catalog.length,
    availableCount: available.length,
    versions,
    providers: [...new Set(providerIds)].map((provider) => ({
      provider,
      auth: sanitizeRuntimeAuth(authStatuses.get(provider)),
      models: catalog
        .filter((model) => model.provider === provider)
        .map((model) => ({
          id: model.id,
          name: model.name || `${model.provider}/${model.id}`,
          available: availableKeys.has(modelKey(model)),
        })),
    })),
  };
}

/** SDK から読んだランタイムのスナップショット (非同期・失敗しうる)。公開 state はここから純粋に導出する。 */
export interface ModelSnapshot {
  /** 許可リスト適用前の利用可能モデル */
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
  /** 候補はあるが保存された既定が無い状態。モデルを選ばずに新規会話を作ると 503 になる */
  defaultModelUnset: boolean;
  availabilityError?: string;
  modelWhitelistExcludesAll: boolean;
  catalog?: RuntimeModelsResponse;
}

/** 可用 0 の安全な state。導出そのものが失敗したときだけ使う (古い可用一覧を成功として残さない) */
export function unavailableModelState(availabilityError?: string): ModelState {
  return {
    availableModels: [],
    modelOptions: [],
    modelWhitelistExcludesAll: false,
    defaultModelUnset: false,
    ...(availabilityError ? { availabilityError } : {}),
  };
}

/**
 * SDK から読むスナップショット。`signal` は SDK の認証ストアのロック待ちへも伝わるため、
 * 期限を共有した呼び出し側が「期限後は公開 state を差し替えない」を決められる (読み取りの中断と失敗を混ぜない)。
 */
export async function readModelSnapshot(
  modelRuntime: ModelRuntime,
  options: { signal?: AbortSignal } = {},
): Promise<ModelSnapshot> {
  const available = [...(await modelRuntime.getAvailable(undefined, signalOptions(options.signal)))];
  const providerIds = modelRuntime.getProviders().map((provider) => provider.id);
  const authStatuses = new Map(
    providerIds.map((provider) => [provider, modelRuntime.getProviderAuthStatus(provider)] as const),
  );
  return { available, catalog: [...modelRuntime.getModels()], providerIds, authStatuses };
}

/** 期限が無いときは SDK へ undefined を渡し、既存の呼び出しと同じ形を保つ */
function signalOptions(signal: AbortSignal | undefined): { signal: AbortSignal } | undefined {
  return signal ? { signal } : undefined;
}

export interface ModelStateInput {
  snapshot: ModelSnapshot;
  /** 保存されたアプリ既定モデル (undefined = 未設定。候補の先頭では代用しない) */
  requested: ModelRef | undefined;
  whitelist: ModelRef[] | undefined;
  versions: RuntimeVersions;
}

/**
 * スナップショット読取から公開 state までを 1 回分行う。非同期の失敗 (SDK) も導出の失敗 (バグ・契約外データ)
 * も例外にせず、可用 0 の安全な state へ寄せる。
 */
export async function readModelState(input: {
  modelRuntime: ModelRuntime;
  requested: ModelRef | undefined;
  whitelist: ModelRef[] | undefined;
  versions: RuntimeVersions;
  /** health / availabilityError に出るため、SDK の例外文言はここで必ずマスクする */
  maskError: (error: unknown) => string;
  /** 読み取りの期限。abort はここでは例外にせず、可用 0 の安全な state へ寄せる (保持の判断は呼び出し側) */
  signal?: AbortSignal;
}): Promise<ModelState> {
  let snapshot: ModelSnapshot;
  try {
    snapshot = await readModelSnapshot(input.modelRuntime, signalOptions(input.signal) ?? {});
  } catch (error) {
    let catalog: PiAiModel<Api>[] = [];
    try {
      catalog = [...input.modelRuntime.getModels()];
    } catch {
      // カタログも読めないときは空のまま (GET /api/runtime/models は 503 になる)
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
 * カタログの導出を 1 箇所に閉じ、すべての値が同じ available から決まるようにする。
 */
export function deriveModelState({ snapshot, requested, whitelist, versions }: ModelStateInput): ModelState {
  const availableModelList = filterModelsByWhitelist(snapshot.available, whitelist);
  let availabilityError = snapshot.availabilityError;
  let modelWhitelistExcludesAll = false;
  if (whitelist && !availabilityError && availableModelList.length === 0) {
    // 認証が未設定でも許可リストは必ず空になるため、対処先を絞れるよう両方を確認させる文言で返す。
    modelWhitelistExcludesAll = true;
    availabilityError = MODEL_WHITELIST_EMPTY_MESSAGE;
  }

  // getModel() は認証の有無を見ないため、保存された既定モデルも getAvailable() と突き合わせる。
  const selectedModel = requested
    ? availableModelList.find((model) => model.provider === requested.provider && model.id === requested.id)
    : undefined;
  let defaultModelError: string | undefined;
  if (requested && !selectedModel) {
    // 利用不能でも他候補へ黙ってフォールバックせず、ready のままエラーとして伝える。
    defaultModelError = `保存された既定モデルは利用できません: ${requested.provider}/${requested.id}`;
  }
  // 保存された既定が無い状態は「未設定」として公開する。候補の先頭を勝手に既定にすると、
  // 契約で使えないモデルを選んでしまい、原因の分からない初回失敗になる。
  const defaultModelUnset = !requested && availableModelList.length > 0;

  if (availableModelList.length === 0 && !availabilityError && !defaultModelError) {
    const requestedProvider = requested?.provider;
    const hasConfiguredProvider = requestedProvider
      ? sanitizeRuntimeAuth(snapshot.authStatuses.get(requestedProvider)).configured
      : snapshot.providerIds.some((provider) => sanitizeRuntimeAuth(snapshot.authStatuses.get(provider)).configured);
    availabilityError = hasConfiguredProvider ? MODEL_UNAVAILABLE_MESSAGE : AUTH_REQUIRED_MESSAGE;
  }

  let catalog: RuntimeModelsResponse | undefined;
  if (!snapshot.availabilityError) {
    try {
      catalog = deriveRuntimeCatalog({
        catalog: snapshot.catalog,
        available: snapshot.available,
        providerIds: snapshot.providerIds,
        authStatuses: snapshot.authStatuses,
        versions,
      });
    } catch {
      // カタログの導出は best-effort。失敗しても既存のモデル選択の振る舞いを変えない。
    }
  }

  return {
    availableModels: availableModelList,
    modelOptions: availableModelList.map(modelOptionOf),
    selectedModel,
    defaultModelError,
    defaultModelUnset,
    availabilityError,
    modelWhitelistExcludesAll,
    catalog,
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

  // 実効選択は DB を正とする ModelSettingsService が setModelSelection() で写す。ここでは「制限なし・
  // 既定は未設定」で初回 state を立て、DB を開いた後の applyStored() が保存値へ確定させる。
  const selection: ModelSelection = { allowedModels: undefined, defaultModel: undefined };
  const versions = runtimeVersionInfo();
  const maskError = (error: unknown): string => secretMasker.mask(errorMessage(error));
  // 画像生成は DB を正とする ImageSettingsService が setImageGeneration() で写す。初期値は無効で、
  // ツール定義はセッション作成時にこの値を見る（既存会話へ遡及しない）
  const imageGeneration: { config: ImageGenerationConfig | undefined } = { config: undefined };
  const imagesGenerator = createImagesGenerator({ maskText: maskError });
  // Web 検索の設定も DB を正とする WebSearchSettingsService が写す。既定は有効 / Exa で、
  // ツールは execute のたびにここを読む（セッション作成時に凍結しない）
  const webSearch: { config: WebSearchRuntimeConfig } = {
    config: {
      readEnabled: () => true,
      readProvider: () => DEFAULT_WEB_SEARCH_PROVIDER,
      readApiKey: () => undefined,
    },
  };
  // serve ツールの実体は bootstrap (アプリデータとサンドボックスを持つ層) が注入する。未注入なら公開しない
  const serveHost: { value: ServeToolHost | null } = { value: null };
  // ask_user の実体も bootstrap が注入する。待機の所有者は SessionStore (run 状態と同じ場所に置く)
  const askUserHost: { value: AskUserHost | null } = { value: null };
  // 変数 (作業環境 → 環境変数) の解決源も同じく bootstrap が注入する。未注入なら env 無しで実行する
  const sessionEnv: { value: SessionEnvSource | null } = { value: null };

  const current = { value: unavailableModelState() };
  /**
   * 公開 state の差し替え。ロックの内側でだけ呼び、例外は出さない (lock を壊さない)。
   * 期限切れの読み取りは現在値を保つ: 期限に当たったのは取得の失敗と同じではなく、一覧を空で確定できないため。
   */
  async function refreshModelState(options: { signal?: AbortSignal } = {}): Promise<void> {
    const next = await readModelState({
      modelRuntime,
      requested: selection.defaultModel,
      whitelist: selection.allowedModels,
      versions,
      maskError,
      ...signalOptions(options.signal),
    });
    if (options.signal?.aborted) return;
    current.value = next;
  }
  await refreshModelState();

  async function refreshModelCatalog({
    allowNetwork,
    force,
    signal,
  }: {
    allowNetwork: boolean;
    force: boolean;
    signal: AbortSignal;
  }): Promise<ModelCatalogRefreshAttempt> {
    const result = await modelRuntime.refresh({ allowNetwork, force, signal });
    return { aborted: result.aborted, failedProviders: result.errors.size };
  }

  const defaultThinkingLevel = parseThinkingLevelFromEnv();

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
    ownerSessionId,
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
        current.value.defaultModelError ||
          current.value.availabilityError ||
          (current.value.defaultModelUnset ? MODEL_UNSET_MESSAGE : AUTH_REQUIRED_MESSAGE),
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
    // ツール一覧はセッション作成時に固定する。画像ツールの有効化は新しい会話と復元から効く
    const imageGenerationEnabled = imageGeneration.config?.enabled === true;
    const serveToolEnabled = serveHost.value?.configured === true;
    // 質問ツールは常時有効 (PI_AGENT_TOOLS の allowlist には依存させない)。実体未注入のときだけ落とす
    const askUserEnabled = askUserHost.value !== null;
    const baseTools = configuredTools();
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
      appendSystemPrompt: [
        appendSystemPrompt(rootCwd, { imageGeneration: imageGenerationEnabled }),
        snapshot.agent,
      ].filter(Boolean),
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
      // web_search と ask_user はどちらも BFF ローカルの customTool。allowlist (tools) には
      // それぞれの追加分を足すだけで、片方が他方を上書きしない
      tools: withAskUserTool(
        withWebSearchTool(withServeTool(sessionToolNames(baseTools, imageGenerationEnabled), serveToolEnabled)),
        askUserEnabled,
      ),
      // 組込み定義を「サンドボックスの実行API を呼ぶリモート定義」で置き換え、BFF 上で作業コードを実行しない。
      // web_search・画像生成・serve は BFF ローカルの customTool として足す（サンドボックスには送らない）
      customTools: [
        ...createRemoteToolDefinitions({
          cwd: sessionCwd,
          rootCwd,
          sandboxCwd: relativeCwd,
          client: sandboxClient,
          masker: secretMasker,
          tools: baseTools,
          catalogSkills: catalogSkillBodies,
          // 解決は exec のたびに行う (設定の変更は次の bash から効く)
          envForCwd: () => sessionEnv.value?.variablesFor(relativeCwd) ?? {},
        }),
        ...createWebSearchToolDefinitions({
          masker: secretMasker,
          readEnabled: () => webSearch.config.readEnabled(),
          readProvider: () => webSearch.config.readProvider(),
          readApiKey: (provider) => webSearch.config.readApiKey(provider),
        }),
        ...createImageToolDefinitions({
          enabled: imageGenerationEnabled,
          sessionCwd: relativeCwd,
          workspace: sandboxClient,
          masker: secretMasker,
          readSettings: () => imageGeneration.config?.read(),
          readOutputFormats: (model) => imageGeneration.config?.readOutputFormats(model),
          generate: imagesGenerator.generate,
        }),
        ...createServeToolDefinitions({
          enabled: serveToolEnabled,
          sessionId: ownerSessionId ?? sessionId,
          host: serveHost.value as ServeToolHost,
        }),
        ...createAskUserToolDefinitions({
          enabled: askUserEnabled,
          sessionId: ownerSessionId ?? sessionId,
          host: askUserHost.value as AskUserHost,
        }),
      ],
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
    get defaultModelUnset() {
      return current.value.defaultModelUnset;
    },
    get availabilityError() {
      return current.value.availabilityError;
    },
    get modelWhitelistExcludesAll() {
      return current.value.modelWhitelistExcludesAll;
    },
    get modelCatalog() {
      return current.value.catalog;
    },
    sandboxConfigured: Boolean(sandboxClient),
    tools: configuredTools(),
    resolveModel,
    createSession,
    modelLabel,
    secretMasker,
    retainSecret,
    setModelSelection(next) {
      selection.allowedModels = next.allowedModels;
      selection.defaultModel = next.defaultModel;
    },
    get imageGenerationEnabled() {
      return imageGeneration.config?.enabled === true;
    },
    setImageGeneration(config) {
      imageGeneration.config = config;
    },
    setWebSearch(config) {
      webSearch.config = config;
    },
    setServe(host) {
      serveHost.value = host;
    },
    setAskUser(host) {
      askUserHost.value = host;
    },
    setSessionEnv(source) {
      sessionEnv.value = source;
    },
    refreshModelState,
    refreshModelCatalog,
  };
}
