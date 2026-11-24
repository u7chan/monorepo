/** pi ランタイムと SDK セッションのファクトリ。認証はあえて pi の通常の解決 (auth.json / OAuth / プロバイダー環境変数) に委ねる。 */
import {
  createAgentSession,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model as PiAiModel } from "@earendil-works/pi-ai";
import { join, resolve } from "node:path";
import { createAskUserToolDefinitions, ASK_USER_TOOL_NAME, type AskUserHost } from "./ask-user-tool";
import {
  REQUEST_NETWORK_ACCESS_TOOL_NAME,
  createRequestNetworkAccessToolDefinitions,
  type NetworkAccessHost,
} from "./request-network-access-tool";
import { createBgmGenerator, type BgmGenerationInput } from "./bgm";
import { contentGenerationDisabled } from "./content-disabled";
import { createBgmToolDefinitions, BGM_TOOL_NAME } from "./bgm-tools";
import { messageFor } from "./errors";
import { discoverSessionFileSkills } from "./file-skills";
import { createImageToolDefinitions, IMAGE_TOOL_NAME } from "./image-tools";
import {
  createImagesGenerator,
  type ContentGenerationConfig,
  type ImageGenerationInput,
  type ImageGenerationResult,
} from "./images";
import { createCodexImagesGenerator } from "./codex-images";
import { IMAGE_INPUT_UNKNOWN_MESSAGE } from "./image-catalog";
import {
  AUTH_REQUIRED_MESSAGE,
  MODEL_UNSET_MESSAGE,
  parseThinkingLevelFromEnv,
  readModelState,
  runtimeVersionInfo,
  unavailableModelState,
  type ModelCatalogRefreshAttempt,
  type ModelSelection,
} from "./model-state";
import {
  createSpeechGenerator,
  type SpeechFormatStore,
  type SpeechGenerationInput,
  type SpeechGenerationResult,
} from "./speech";
import { createSpeechToolDefinitions, SPEECH_TOOL_NAME } from "./speech-tools";
import { createInvestigateToolDefinitions, INVESTIGATE_TOOL_NAME, type InvestigateHost } from "./investigate-tool";
import { formatModelRef, modelLabel } from "./model-ref";
import { resolveWorkspaceCwd } from "./projects";
import { appendSystemPrompt, composePromptSnapshot, investigationSystemPrompt } from "./session-prompt";
import { compactionSettingsFromEnv, createSessionResourceLoader, createSessionSettings } from "./session-settings";
import { createServeToolDefinitions, SERVE_TOOL_NAME, type ServeToolHost } from "./serve-tool";
import { createSandboxToolClientFromEnv } from "./sandbox/client";
import { createRemoteToolDefinitions } from "./sandbox/remote-tools";
import { configuredTools, hostToolDefinitions, investigationTools, sessionToolPlan } from "./tool-plan";
import { toolCatalog, type ToolAvailability } from "./tool-catalog";
import { createMutableSecretMasker, type SecretMasker } from "./redact";
import { DEFAULT_WEB_SEARCH_PROVIDER } from "./web-search-providers";
import { createWebSearchToolDefinitions, WEB_SEARCH_TOOL_NAME, type WebSearchRuntimeConfig } from "./web-search-tool";
import { collectSecretValues, extraSecretVarNames } from "./secret-guard";
import type { AgentDef, ModelOption, ModelRef, RuntimeModelsResponse, ThinkingLevel, ToolCatalogEntry } from "./schema";
import type { PromptSnapshot } from "./session-store";

export interface PiModelRef {
  provider: string;
  id: string;
}

export const SANDBOX_SETUP_REQUIRED_MESSAGE =
  "サンドボックスが設定されていません。PI_SANDBOX_URL と PI_SANDBOX_TOKEN を設定してサーバーを再起動してください (ローカルでのツール実行にはフォールバックしません)。";

/** 設定の入口を GUI へ移した後も process.env に残りうる、読み取らなくなった環境変数 */
export const IGNORED_MODEL_ENVIRONMENT_VARIABLES = ["PI_MODELS", "PI_MODEL", "PI_PROVIDER"] as const;

/** 残っている環境変数名を起動ログと設定画面の注記へ出す。空文字は「設定していない」と同じ扱い */
export function ignoredModelEnvironmentVariables(env: NodeJS.ProcessEnv = process.env): string[] {
  return IGNORED_MODEL_ENVIRONMENT_VARIABLES.filter((name) => env[name]?.trim());
}

export interface CreateSessionInput {
  agent?: AgentDef;
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
  /** 復元時: 作成時のプロンプトスナップショット。無ければ agent から組む */
  promptSnapshot?: PromptSnapshot;
  /** この会話の添付置き場（root 相対。所属スペースで変わる）。参照画像の許可範囲に使う */
  uploadsDirRel?: string;
  /**
   * 共通スキルの許可リスト。undefined = 全可視、`[]` = すべて OFF。作成 / 復元ではエージェントの
   * スナップショットから渡し、注入経路 (skillsOverride) と解決経路で同じ値にする。
   */
  commonSkillNames?: string[];
  /**
   * 組み込みスキルの許可リスト。undefined = 全部 ON、`[]` = すべて OFF。注入経路 (skillsOverride)・
   * `read` の横取り・system prompt の案内で同じ値にする (作成 / 復元ではスナップショットから渡す)。
   */
  builtinSkillNames?: string[];
  /**
   * 組み込みスキルを自然文で発火させるか。false なら組み込みスキルを索引から外す (既定 true)。
   * 作成 / 復元ではエージェントのスナップショットから渡す。ファイルスキル側とは独立
   */
  allowNaturalInvocationBuiltin?: boolean;
  /** ファイルスキル (共通 / プロジェクト) 側の同じスイッチ */
  allowNaturalInvocationFile?: boolean;
  /**
   * ツールの許可リスト。undefined = 全部 ON、`[]` = すべて OFF。実効はアプリ側の可否との積で、
   * セッション作成時に確定する (復元は meta のスナップショットで、定義の編集を遡及させない)。
   * 子 (investigation) は親の許可リストを読み取り専用の集合との積で引き継ぐ
   */
  toolNames?: string[];
  /** 子モード。読み取り専用ツールだけを公開し、常時有効群とスキル発見を落とす (既定 "chat") */
  mode?: SessionMode;
}

export type SessionMode = "chat" | "investigation";

/**
 * エージェントの bash へ渡す「変数」の解決元 (作業フォルダ = cwd がキー)。
 * 値ではなく解決関数を渡すのは、変更を「次の bash」から反映させるため。
 */
export interface SessionEnvSource {
  variablesFor(cwd: string): Record<string, string>;
}

/**
 * エージェントの bash へ渡す Git identity の解決源。bootstrap がアプリ DB を持ち、exec のたびに読む。
 * 未設定と読取障害は null で、サンドボックスは useConfigOnly だけの config にする。
 */
export interface GitIdentitySource {
  identityForExec(): { userName: string; userEmail: string } | null;
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
  /**
   * GET /api/agents が返すツールの一覧。アプリ側の実効は取得時点で凍結したスナップショットで、
   * Web 検索の設定などを保存した後はクライアントがカタログを取り直す。
   */
  toolCatalog(): ToolCatalogEntry[];
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
  contentGenerationEnabled: boolean;
  /**
   * コンテンツ生成の設定を注入する。DB を正とする ContentSettingsService が同じロックの内側で呼び、
   * `read` は常に差し替える（既存セッションの execute は削除後も現在の行を見に行く）
   */
  setContentGeneration(config: ContentGenerationConfig): void;
  /**
   * 音声の形式の学習結果の保存先を注入する。createPiBff は DB を持たないため bootstrap が渡し、
   * 未注入（ランタイムなしで起動）はプロセス内のメモだけで動く。生成器は呼び出しのたびにここを読む。
   */
  setSpeechFormatStore(store: SpeechFormatStore): void;
  /**
   * 設定 → コンテンツ生成 の音声の試行が使う生成器。ツールと同じ形式の学習メモを共有するため、
   * プレイグラウンドの試行でも mp3 / pcm の使い分けが進む。
   */
  generateSpeech(input: SpeechGenerationInput): Promise<SpeechGenerationResult>;
  /**
   * 設定 → コンテンツ生成 の試行ジョブが使う画像の生成器。ツールと同じ失敗分類・期限を共有する。
   * 成果物はチャット側と違い保存しない（段階 1 は記録のみ）。
   */
  generateImage(input: ImageGenerationInput): Promise<ImageGenerationResult>;
  /**
   * 設定 → コンテンツ生成 の BGM の試行が使う生成器。チャットの `generate_bgm` と同じ生成器・同じ
   * プロセス内の同時実行枠を共有する（失敗は例外で返る）。
   */
  generateBgm(input: BgmGenerationInput): Promise<Uint8Array<ArrayBuffer>>;
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
  setNetworkAccess(host: NetworkAccessHost): void;
  /**
   * investigate ツールの実体を注入する。子の生成と並列の所有は SessionStore 側の runner が持ち、
   * ツールはここの investigate を await する
   */
  setInvestigate(host: InvestigateHost): void;
  /**
   * 作業フォルダの変数をエージェントの bash へ注入する。bootstrap がアプリデータ (secrets) を持つため、
   * 解決はこの源へ委譲する (シークレットはここへ入れない)
   */
  setSessionEnv(source: SessionEnvSource): void;
  /**
   * Git のグローバル identity をエージェントの bash へ渡す。bootstrap がアプリデータを持つため、
   * 解決はこの源へ委譲する (設定画面の保存は次の bash から効く)
   */
  setGitIdentity(source: GitIdentitySource): void;
}

/**
 * bootstrap が起動後に差し込むホストと設定。BFF はこれらが揃う前に起動するため、未設定のときの扱いを
 * ここで決める: ホストが未設定なら対応するツールを公開せず、設定が未設定なら既定で動く。
 */
interface PiBffHosts {
  /** アプリデータとサンドボックスを持つ bootstrap が注入する。未注入なら serve を公開しない */
  serve: ServeToolHost | null;
  /** 待機の所有者は SessionStore。未注入なら ask_user を公開しない */
  askUser: AskUserHost | null;
  /** 子の生成と並列の所有者は SessionStore 側の runner。未注入なら investigate を公開しない */
  investigate: InvestigateHost | null;
  /** egress ポリシー。未注入なら承認ツールを公開しない */
  networkAccess: NetworkAccessHost | null;
  /** 作業環境の変数の解決源。未注入なら env 無しで実行する */
  sessionEnv: SessionEnvSource | null;
  /** Git identity。未注入なら gitConfig を送らない */
  gitIdentity: GitIdentitySource | null;
  /** 音声の形式の学習結果。DB を持たないため、未注入ならプロセス内のメモだけで動く */
  speechFormatStore: SpeechFormatStore | null;
  /** コンテンツ生成の設定。未設定は無効で、ツール定義はセッション作成時にこの値を見る (既存会話へ遡及しない) */
  contentGeneration: ContentGenerationConfig | undefined;
  /** Web 検索の設定。未設定は無効 / Exa で、ツールは execute のたびにここを読む (セッション作成時に凍結しない) */
  webSearch: WebSearchRuntimeConfig;
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
  const maskError = (error: unknown): string => secretMasker.mask(messageFor(error));
  const hosts: PiBffHosts = {
    serve: null,
    askUser: null,
    investigate: null,
    networkAccess: null,
    sessionEnv: null,
    gitIdentity: null,
    speechFormatStore: null,
    contentGeneration: undefined,
    webSearch: {
      readEnabled: () => false,
      readProvider: () => DEFAULT_WEB_SEARCH_PROVIDER,
      readApiKey: () => undefined,
    },
  };
  const imagesGenerator = createImagesGenerator({ maskText: maskError });
  // Codex は応答の形も期限も違うため別のアダプタにする。呼び出し側は provider を渡すだけでよい
  const codexImagesGenerator = createCodexImagesGenerator({ maskText: maskError });
  const generateImage = (input: ImageGenerationInput): Promise<ImageGenerationResult> =>
    input.provider === "codex"
      ? codexImagesGenerator.generate({ prompt: input.prompt, auth: input.auth, signal: input.signal })
      : imagesGenerator.generate(input);
  const speechGenerator = createSpeechGenerator({
    maskText: maskError,
    store: {
      read: (model) => hosts.speechFormatStore?.read(model),
      save: (model, format) => hosts.speechFormatStore?.save(model, format),
    },
  });
  const bgmGenerator = createBgmGenerator({ maskText: maskError });

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
      ...(options.signal ? { signal: options.signal } : {}),
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

  /**
   * アプリ側のツールの実効。GET /api/agents の `available` とセッション作成の可否を同じ値から引くため、
   * レジストリ (`tool-catalog.ts`) へ渡す入力をここで 1 回に揃える。
   */
  function toolAvailability(): ToolAvailability {
    return {
      sandboxTools: configuredTools(),
      imageGeneration: hosts.contentGeneration?.imageAvailability() ?? { enabled: false, reason: "no_key" },
      contentGeneration: hosts.contentGeneration?.enabled === true,
      contentGenerationConfigured: hosts.contentGeneration?.configured === true,
      webSearch: hosts.webSearch.readEnabled(),
      serve: hosts.serve?.configured === true,
      askUser: hosts.askUser !== null,
      requestNetworkAccess: hosts.networkAccess !== null,
      investigate: hosts.investigate !== null,
    };
  }

  const resolveModel = (model: ModelRef): PiAiModel<Api> | undefined =>
    current.value.availableModels.find(
      (candidate) => candidate.provider === model.provider && candidate.id === model.id,
    );
  // 検証時だけ閾値を下げる。未設定なら u7agent の既定 (65536 / 20000) を使う。
  const compactionSettings = compactionSettingsFromEnv();

  async function createSession({
    agent,
    model,
    thinkingLevel,
    cwd: requestedCwd = "",
    sessionId,
    ownerSessionId,
    entries,
    promptSnapshot,
    uploadsDirRel,
    commonSkillNames,
    builtinSkillNames,
    allowNaturalInvocationBuiltin,
    allowNaturalInvocationFile,
    toolNames,
    mode = "chat",
  }: CreateSessionInput = {}): Promise<{ session: unknown; promptSnapshot: PromptSnapshot }> {
    const investigation = mode === "investigation";
    const naturalInvocationBuiltin = allowNaturalInvocationBuiltin !== false;
    // 不正な cwd はモデル解決より先に 400 にする (実行できない指定を 503 の裏に隠さない)
    const { relative: relativeCwd, absolute: sessionCwd } = resolveWorkspaceCwd(rootCwd, requestedCwd);
    // 明示されたモデルは利用可能一覧と厳密照合する
    const modelObject = model ? resolveModel(model) : current.value.selectedModel;
    if (model && !modelObject) {
      const error = new Error(`Model is not available: ${formatModelRef(model)}`) as Error & {
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
      const error = new Error(SANDBOX_SETUP_REQUIRED_MESSAGE) as Error & { statusCode?: number };
      error.statusCode = 503;
      throw error;
    }
    // セッションを使い捨てに保つ: JSONL セッションファイルを作らず、ユーザーの pi 設定にも書き込まない。
    const settingsManager = SettingsManager.inMemory(createSessionSettings(compactionSettings));
    const snapshot = promptSnapshot ?? composePromptSnapshot(agent);
    // ツールの実効はセッション作成時に確定する (作成 / 復元のどちらも呼び出し側が渡すスナップショットを使い、
    // 実行時にエージェント定義を読まない)。子は作業ツールだけを親から引き継ぐ
    const availability = toolAvailability();
    const sessionTools = sessionToolPlan({
      base: investigation ? investigationTools(configuredTools()) : configuredTools(),
      ...(toolNames === undefined ? {} : { toolNames }),
      availability,
      investigation,
    });
    const appTool = (name: string) => sessionTools.enabled.has(name);
    // ファイルスキルは SDK のネイティブ発見を使わず、サンドボックスで発見した一覧を skillsOverride で渡す
    // (発見に失敗してもスキル無しでセッション作成を続行する)。子はスキルを使わないので往復もしない
    const fileSkills = investigation
      ? { skills: [] }
      : await discoverSessionFileSkills(sandboxClient, {
          rootCwd,
          relativeCwd,
          ...(commonSkillNames === undefined ? {} : { commonSkillNames }),
          ...(builtinSkillNames === undefined ? {} : { builtinSkillNames }),
          allowNaturalInvocationBuiltin: naturalInvocationBuiltin,
          ...(allowNaturalInvocationFile === undefined ? {} : { allowNaturalInvocationFile }),
        });
    const resourceLoader = createSessionResourceLoader({
      cwd: sessionCwd,
      agentDir,
      settingsManager,
      secretMasker,
      appendSystemPrompt: [
        investigation
          ? investigationSystemPrompt()
          : appendSystemPrompt(rootCwd, {
              imageGeneration: appTool(IMAGE_TOOL_NAME),
              speechGeneration: appTool(SPEECH_TOOL_NAME),
              bgmGeneration: appTool(BGM_TOOL_NAME),
              requestNetworkAccess: appTool(REQUEST_NETWORK_ACCESS_TOOL_NAME),
              ...(builtinSkillNames === undefined ? {} : { builtinSkillNames }),
              allowNaturalInvocationBuiltin: naturalInvocationBuiltin,
            }),
        snapshot.agent,
      ].filter(Boolean),
      fileSkills: fileSkills.skills,
      injectSkills: !investigation,
    });
    await resourceLoader.reload();

    // 承認の key に使う SDK のセッション id。永続化なしの会話は createSession に id が来ず、
    // SDK が発行するため、作成後に実際の id で埋める (定義の生成時点では決まらない)。
    const sdkSessionId: { value: string | undefined } = { value: sessionId };
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
      // web_search / 画像生成 / 音声生成 / serve / ask_user / investigate は BFF ローカルの customTool。
      // 登録名と enabled は sessionToolPlan が同じ判定から組む (片方だけ足すと食い違う)。
      // 子モードでは常時有効群を一切足さない
      tools: sessionTools.names,
      // 組込み定義を「サンドボックスの実行API を呼ぶリモート定義」で置き換え、BFF 上で作業コードを実行しない。
      // web_search・画像生成・serve・ask_user・investigate は BFF ローカルの customTool として足す
      // (サンドボックスには送らない)
      customTools: [
        ...createRemoteToolDefinitions({
          cwd: sessionCwd,
          rootCwd,
          sandboxCwd: relativeCwd,
          client: sandboxClient,
          masker: secretMasker,
          tools: sessionTools.sandbox,
          ...(builtinSkillNames === undefined ? {} : { builtinSkillNames }),
          // 解決は exec のたびに行う (設定の変更は次の bash から効く)
          envForCwd: () => hosts.sessionEnv?.variablesFor(relativeCwd) ?? {},
          ...(hosts.gitIdentity ? { gitConfigForExec: () => hosts.gitIdentity?.identityForExec() ?? null } : {}),
          // 承認は exec のたびに解決する (同じ会話の途中で変わる)。key は SDK の sessionId なので、
          // investigate の子は親の承認を継承しない。id を解決できないときは開かない (fail-closed)
          ...(hosts.networkAccess
            ? {
                networkAccessForExec: () => {
                  const id = sdkSessionId.value;
                  return id !== undefined && hosts.networkAccess?.allows(id) === true;
                },
              }
            : {}),
        }),
        ...(investigation
          ? []
          : [
              // 公開の判定は `tools` の名前と同じ `appTool` を通す (定義だけ足して登録しない状態を作らない)
              ...(appTool(WEB_SEARCH_TOOL_NAME)
                ? createWebSearchToolDefinitions({
                    masker: secretMasker,
                    readEnabled: () => hosts.webSearch.readEnabled(),
                    readProvider: () => hosts.webSearch.readProvider(),
                    readApiKey: (provider) => hosts.webSearch.readApiKey(provider),
                  })
                : []),
              ...createImageToolDefinitions({
                enabled: appTool(IMAGE_TOOL_NAME),
                sessionCwd: relativeCwd,
                rootCwd,
                uploadsDirRel,
                workspace: sandboxClient,
                masker: secretMasker,
                // 公開はセッション作成時に凍結するが、OFF はこの 1 行で既存の会話にも次の呼び出しから効く。
                // キー未設定を OFF と混同しないよう、公開の `enabled` ではなくトグルの `disabled` を見る
                readEnabled: () => !contentGenerationDisabled(hosts.contentGeneration),
                readSettings: () => hosts.contentGeneration?.read(),
                readOutputFormats: (model) => hosts.contentGeneration?.readOutputFormats(model),
                readParameters: (model) => hosts.contentGeneration?.readParameters(model),
                checkImageInput: async (model, signal) =>
                  hosts.contentGeneration
                    ? hosts.contentGeneration.checkImageInput(model, signal)
                    : IMAGE_INPUT_UNKNOWN_MESSAGE,
                readImageInput: (path, scope, signal) => sandboxClient.readImageInput(path, scope, signal),
                generate: generateImage,
              }),
              ...createSpeechToolDefinitions({
                enabled: appTool(SPEECH_TOOL_NAME),
                sessionCwd: relativeCwd,
                workspace: sandboxClient,
                masker: secretMasker,
                readEnabled: () => !contentGenerationDisabled(hosts.contentGeneration),
                readSettings: () => hosts.contentGeneration?.readSpeech(),
                readVoices: (model) => hosts.contentGeneration?.readVoices(model),
                generate: speechGenerator.generate,
              }),
              ...createBgmToolDefinitions({
                enabled: appTool(BGM_TOOL_NAME),
                sessionCwd: relativeCwd,
                workspace: sandboxClient,
                masker: secretMasker,
                readEnabled: () => !contentGenerationDisabled(hosts.contentGeneration),
                readSettings: () => hosts.contentGeneration?.readBgm(),
                generate: bgmGenerator.generate,
              }),
              ...hostToolDefinitions(hosts.serve, (host) =>
                createServeToolDefinitions({
                  enabled: appTool(SERVE_TOOL_NAME),
                  sessionId: ownerSessionId ?? sessionId,
                  host,
                  // 外した / 自然文では発火しない skill を説明が指したままだと、モデルが読めない skill を探す
                  ...(builtinSkillNames === undefined ? {} : { builtinSkillNames }),
                  allowNaturalInvocationBuiltin: naturalInvocationBuiltin,
                }),
              ),
              ...hostToolDefinitions(hosts.askUser, (host) =>
                createAskUserToolDefinitions({
                  enabled: appTool(ASK_USER_TOOL_NAME),
                  sessionId: ownerSessionId ?? sessionId,
                  host,
                }),
              ),
              ...hostToolDefinitions(hosts.networkAccess, (host) =>
                createRequestNetworkAccessToolDefinitions({
                  enabled: appTool(REQUEST_NETWORK_ACCESS_TOOL_NAME),
                  // 承認の key は exec 側と同じ SDK の sessionId にする (owner の id で記録すると exec が読めない)。
                  // 定義の生成時点では id が決まらないため、実行時に解決する
                  sessionId: () => sdkSessionId.value,
                  host,
                }),
              ),
              ...hostToolDefinitions(hosts.investigate, (host) =>
                createInvestigateToolDefinitions({
                  enabled: appTool(INVESTIGATE_TOOL_NAME),
                  sessionId: ownerSessionId ?? sessionId,
                  host,
                  masker: secretMasker,
                }),
              ),
            ]),
      ],
    };

    const { session } = await createAgentSession(options);
    // 永続化なしの会話はここで初めて id が決まる。承認の key を exec 側と揃えるため、作成分で埋める
    sdkSessionId.value = session.sessionId ?? sessionId;
    return { session, promptSnapshot: snapshot };
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
    toolCatalog: () => toolCatalog(toolAvailability()),
    resolveModel,
    createSession,
    modelLabel,
    secretMasker,
    retainSecret,
    setModelSelection(next) {
      selection.allowedModels = next.allowedModels;
      selection.defaultModel = next.defaultModel;
    },
    get contentGenerationEnabled() {
      return hosts.contentGeneration?.enabled === true;
    },
    setContentGeneration(config) {
      hosts.contentGeneration = config;
    },
    setSpeechFormatStore(store) {
      hosts.speechFormatStore = store;
    },
    generateSpeech: (input) => speechGenerator.generate(input),
    generateImage,
    generateBgm: (input) => bgmGenerator.generate(input),
    setWebSearch(config) {
      hosts.webSearch = config;
    },
    setServe(host) {
      hosts.serve = host;
    },
    setAskUser(host) {
      hosts.askUser = host;
    },
    setNetworkAccess(host) {
      hosts.networkAccess = host;
    },
    setInvestigate(host) {
      hosts.investigate = host;
    },
    setSessionEnv(source) {
      hosts.sessionEnv = source;
    },
    setGitIdentity(source) {
      hosts.gitIdentity = source;
    },
    refreshModelState,
    refreshModelCatalog,
  };
}
