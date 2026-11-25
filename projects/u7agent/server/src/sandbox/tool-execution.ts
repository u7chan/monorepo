import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getShellConfig,
  type BashSpawnContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Context } from "hono";
import { COMMON_SKILLS_DIR } from "../app-paths";
import { messageFor, pathError } from "../errors";
import { isGitIdentityEnvName } from "../env-names";
import type { GitIdentity } from "../git-identity";
import { isInsideRoot } from "../path-strings";
import { SECRET_MASTER_KEY_ENV, SECRET_MASTER_KEY_FILE_ENV } from "../secret-crypto";
import { SerialLock } from "../serial-lock";
import { touchesCommonSkills } from "./common-skills";
import { parseExecuteRequest, SANDBOX_TOOL_NAMES, type ValidatedExecuteRequest } from "./execute-request";
import { resolveWorkspaceDirectory, throwIfAborted } from "./fs-path";
import { detectDubiousOwnership, gitConfigTarget, prepareGitConfig, type GitConfigFailureReason } from "./git-config";
import {
  fixedLandlockWriteRoots,
  landlockAllowedPorts,
  landlockRulesEnv,
  landlockUnavailableMessage,
  LANDLOCK_MIN_ABI,
  probeLandlockStatus,
  resolveLandlockWrapper,
  type LandlockWriteRoot,
} from "./landlock";
import {
  encodeSandboxEvent,
  type SandboxEvent,
  type SandboxGitConfigStatus,
  type SandboxLandlockStatus,
  type SandboxWriteScopeEntry,
} from "./protocol";
import { readRouteJson, routeError } from "./route-http";
import { isWritablePath, writeScopeError, type WriteScope } from "./write-scope";

/** `gitConfig.ownershipWarnings` に残す cwd の上限。診断の応答を cwd の数だけ大きくしない */
const GIT_OWNERSHIP_WARNING_LIMIT = 20;

type AnyToolDefinition = ToolDefinition<any, any, any>;
type ExecuteUpdateCallback = NonNullable<Parameters<AnyToolDefinition["execute"]>[3]>;

function normalizeToolCallId(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : randomUUID();
}

/**
 * gitConfig 付きの実行から、Git の identity / config を差し替える名前を落とす。
 * 既存行を 400 にすると、旧 BFF が送っている間そのフォルダの bash が全滅するため黙って落とす。
 */
function withoutGitIdentityEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!isGitIdentityEnvName(name)) kept[name] = value;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/** gitConfig 付きの bash を準備できなかったときの理由。パスを含め、権限の修正先を分かるようにする */
function gitConfigFailureMessage(reason: GitConfigFailureReason, path: string): string {
  switch (reason) {
    case "home_unavailable":
      return "Git の設定を書くホームディレクトリを解決できません";
    case "inside_workspace":
      return `Git の設定の置き場所がワークスペースまたは書き込み許可 root の内側になります: ${path}`;
    case "symlink":
      return `Git の設定の親ディレクトリが symlink です: ${path}`;
    default:
      return `Git の設定を書けませんでした: ${path}`;
  }
}

export function createToolExecution(
  rootCwd: string,
  gitPath: string | undefined,
  options: {
    homeDir?: string;
    resolveLandlockExec?: () => string | undefined;
    probeLandlock?: () => Promise<SandboxLandlockStatus>;
  },
  commonSkillGate: SerialLock,
) {
  // ラッパーは PATH からではなく固定パスから解決する (解決できなければ bash を実行しない)
  const landlockExec = options.resolveLandlockExec ? options.resolveLandlockExec() : resolveLandlockWrapper();
  /** ラッパーが exec する本物の shell。SDK の既定の解決結果をそのまま使う (PATH の二重管理をしない) */
  const targetShell = (() => {
    try {
      return getShellConfig(undefined).shell;
    } catch {
      return undefined;
    }
  })();
  const fixedLandlockRoots = fixedLandlockWriteRoots();
  const probeLandlock = options.probeLandlock ?? (() => probeLandlockStatus(landlockExec));
  let landlockProbe: Promise<SandboxLandlockStatus> | undefined;
  /** 診断と bash の入口が同じ結果を使う (ラッパーが使えない環境ではコマンドを実行しない) */
  const landlockStatus = (): Promise<SandboxLandlockStatus> => (landlockProbe ??= probeLandlock());

  const bashUnavailableReason = async (): Promise<string | undefined> => {
    if (!landlockExec) {
      return landlockUnavailableMessage({
        state: "unavailable",
        abi: null,
        minAbi: LANDLOCK_MIN_ABI,
        reason: "wrapper_missing",
      });
    }
    if (!targetShell) return "bash を実行する shell が見つかりません";
    const status = await landlockStatus();
    return status.state === "enabled" ? undefined : landlockUnavailableMessage(status);
  };

  // SDK の bash は process.env を継承するため、このプロセスの秘密値 (共有トークン / master key) は剥がす。
  const spawnHookWithEnv =
    (injected: Record<string, string> | undefined, landlock: Record<string, string>) =>
    (context: BashSpawnContext): BashSpawnContext => {
      // ラッパーの制御変数は injected より後に置き、子から再注入させない
      const env: NodeJS.ProcessEnv = { ...context.env, ...injected, ...landlock };
      delete env.PI_SANDBOX_TOKEN;
      delete env[SECRET_MASTER_KEY_ENV];
      delete env[SECRET_MASTER_KEY_FILE_ENV];
      return { ...context, env };
    };

  const bashFor = (
    cwd: string,
    roots: readonly LandlockWriteRoot[],
    injected?: Record<string, string>,
    networkAccess = true,
  ): AnyToolDefinition =>
    createBashToolDefinition(cwd, {
      exposeSessionEnvironment: false,
      // 未解決でも SDK の既定 shell へは落とさず、実行の入口 (bashUnavailableReason) で断る
      shellPath: landlockExec,
      spawnHook: spawnHookWithEnv(
        injected,
        landlockRulesEnv({ shell: targetShell ?? "", roots, allowedPorts: landlockAllowedPorts(networkAccess) }),
      ),
    });

  const lexicalRoot = resolve(rootCwd);

  /** 要求 cwd から write / edit の許可 root を組む。skillsDir は共通スキル (`<root>/.agents/skills`) で、未作成でも通す。 */
  const writeScopeFor = (requestedCwd: string, executionCwd: string): WriteScope => ({
    cwd: executionCwd,
    lexicalCwd: resolve(lexicalRoot, requestedCwd || "."),
    skillsDir: join(lexicalRoot, COMMON_SKILLS_DIR),
  });

  const agentBashRoots = (executionCwd: string, scope: WriteScope): LandlockWriteRoot[] => [
    { path: executionCwd },
    { path: scope.skillsDir, create: true },
    ...fixedLandlockRoots,
  ];

  /**
   * BFF 内部実行の writeScope (root 相対) を実パスへ。要求由来の値を root 外へ出さず、作成は呼び出し側の
   * 宣言 (create) だけを尊重する (既存の作業ディレクトリは作らない)。
   */
  const requestBashRoots = (entries: readonly SandboxWriteScopeEntry[]): LandlockWriteRoot[] =>
    entries.map((entry) => {
      const target = resolve(lexicalRoot, entry.path || ".");
      if (!isInsideRoot(lexicalRoot, target, sep)) {
        throw pathError(400, `writeScope is outside the workspace: ${entry.path}`);
      }
      return { path: target, create: entry.create === true };
    });

  // アプリの global gitconfig は HOME 配下の固定パスで、write root の外側にある
  const gitTarget = gitConfigTarget(options.homeDir ?? homedir());
  const gitStatus: { state: "ready" | "failed"; reason?: GitConfigFailureReason } = { state: "ready" };
  const ownershipChecked = new Map<string, boolean>();
  const ownershipWarnings: { cwd: string }[] = [];

  const gitConfigStatus = (): SandboxGitConfigStatus => ({
    state: gitStatus.state,
    path: gitTarget.path,
    ...(gitStatus.reason ? { reason: gitStatus.reason } : {}),
    ...(ownershipWarnings.length > 0 ? { ownershipWarnings } : {}),
  });

  /** identity を config へ書く。失敗は次回の exec で再試行できるよう、状態だけを覚えて返す */
  const prepareGitForBash = async (
    identity: GitIdentity | null,
    roots: readonly LandlockWriteRoot[],
  ): Promise<string | undefined> => {
    const result = await prepareGitConfig({
      target: gitTarget,
      identity,
      forbiddenRoots: [lexicalRoot, ...roots.map((root) => root.path)],
    });
    if (result.ok) {
      gitStatus.state = "ready";
      delete gitStatus.reason;
      return undefined;
    }
    gitStatus.state = "failed";
    gitStatus.reason = result.reason;
    return gitConfigFailureMessage(result.reason, gitTarget.path);
  };

  /**
   * system config の `safe.directory` を落とした副作用を、cwd ごとに 1 回だけ確認する。
   * 結果は diagnostics (`GET /v1/runtime/info`) にだけ出し、bash の結果には混ぜない。
   */
  const checkGitOwnership = async (executionCwd: string, requestedCwd: string): Promise<void> => {
    if (ownershipChecked.has(executionCwd)) return;
    const dubious = await detectDubiousOwnership({ gitPath, cwd: executionCwd, configPath: gitTarget.path });
    ownershipChecked.set(executionCwd, dubious);
    if (!dubious) return;
    const entry = { cwd: requestedCwd || "." };
    if (ownershipWarnings.some((item) => item.cwd === entry.cwd)) return;
    ownershipWarnings.push(entry);
    // 診断の応答を cwd の数だけ大きくしない（古い検出から落とす）
    if (ownershipWarnings.length > GIT_OWNERSHIP_WARNING_LIMIT) ownershipWarnings.shift();
  };

  // 起動時の useConfigOnly が後から届いて、最初の exec の identity を上書きしないようにする。
  const gitPrepareLock = new SerialLock();
  const queueGitPrepare = (
    identity: GitIdentity | null,
    roots: readonly LandlockWriteRoot[],
  ): Promise<string | undefined> => {
    return gitPrepareLock.run(() => prepareGitForBash(identity, roots));
  };

  // 起動時に useConfigOnly だけの config を用意する。失敗しても read / write / serve は動かす
  const startupGitPrepare = queueGitPrepare(null, fixedLandlockRoots).catch(() => undefined);

  /**
   * cwd ごとのツール定義。パス解決の起点が定義に焼き込まれるため、実行 cwd ごとに生成して再利用する。
   * key は realpath 解決済みの絶対パス (symlink 経由の別名で重複生成しない) と要求 cwd の lexical 形の組。
   * lexical 形は同じ実行 cwd へ解決する別名でも許可 root が変わるため、key から落とせない。
   */
  const registries = new Map<string, Map<string, AnyToolDefinition>>();
  const registryFor = (cwd: string, scope: WriteScope): Map<string, AnyToolDefinition> => {
    // 区切り文字の衝突で別の許可 root を使わないよう、JSON で組にする (パスに改行は入り得る)
    const key = JSON.stringify([cwd, scope.lexicalCwd]);
    const cached = registries.get(key);
    if (cached) return cached;
    const assertWritable = async (candidate: string): Promise<void> => {
      if (await isWritablePath(candidate, scope)) return;
      throw writeScopeError(candidate, scope.cwd, scope.skillsDir);
    };
    const definitions: AnyToolDefinition[] = [
      bashFor(cwd, agentBashRoots(cwd, scope)),
      createReadToolDefinition(cwd),
      createEditToolDefinition(cwd, {
        operations: {
          access: async (target) => {
            // 判定を実際の access より先に行う (実在しないパスでも SDK に ENOENT を先に出させない)
            await assertWritable(target);
            await access(target, constants.R_OK | constants.W_OK);
          },
          readFile: async (target) => {
            await assertWritable(target);
            return readFile(target);
          },
          writeFile: async (target, content) => {
            await assertWritable(target);
            await writeFile(target, content, "utf-8");
          },
        },
      }),
      createWriteToolDefinition(cwd, {
        operations: {
          // mkdir も判定する (先に許すと拒否パスでも workdir 外に親ディレクトリができる)
          mkdir: async (dir) => {
            await assertWritable(dir);
            await mkdir(dir, { recursive: true });
          },
          writeFile: async (target, content) => {
            await assertWritable(target);
            await writeFile(target, content, "utf-8");
          },
        },
      }),
      createGrepToolDefinition(cwd),
      createFindToolDefinition(cwd),
      createLsToolDefinition(cwd),
    ];
    const registry = new Map<string, AnyToolDefinition>(definitions.map((def) => [def.name, def]));
    registries.set(key, registry);
    return registry;
  };

  const executions = new Map<string, AbortController>();

  /**
   * edit / write の対象が共通スキル置き場の中へ解決するときだけ、実行全体を共通 gate に入れる。
   * SDK の読取〜書込は既に withFileMutationQueue で直列化されているため、順序は gate → ファイル隊列になる。
   */
  const runToolWithGate = async <T>(
    run: () => Promise<T>,
    toolName: string,
    params: ValidatedExecuteRequest["params"],
    cwd: string,
  ): Promise<T> => {
    if (toolName !== "edit" && toolName !== "write") return run();
    const requested = params?.path;
    if (typeof requested !== "string") return run();
    const touched = await touchesCommonSkills({ rootCwd, requested: resolve(cwd, requested), mode: "inside" });
    return touched ? commonSkillGate.run(run) : run();
  };

  const execute = async (c: Context): Promise<Response> => {
    const toolName = c.req.param("tool") ?? "";
    // 定義は cwd ごとに生成するため、未知のツールは名前だけで先に弾く
    if (!(SANDBOX_TOOL_NAMES as readonly string[]).includes(toolName)) {
      return c.json({ error: `Unknown tool: ${toolName}` }, 404);
    }
    const parsed = await readRouteJson(c);
    if (!parsed.ok) return parsed.response;
    let request: ValidatedExecuteRequest;
    try {
      request = parseExecuteRequest(parsed.body);
    } catch (error) {
      return c.json({ error: messageFor(error) }, 400);
    }
    const { requestedCwd, requestedScope } = request;
    let executionCwd: string;
    try {
      executionCwd = (await resolveWorkspaceDirectory(rootCwd, requestedCwd)).target;
    } catch (error) {
      return routeError(c, error, 500);
    }
    // bash の許可 root。エージェントの bash は要求 cwd から導出し、BFF 内部実行は要求 scope だけを使う
    // (内部実行で root へ落ちる既定経路を作らない)。
    let bashRoots: LandlockWriteRoot[] | undefined;
    if (toolName === "bash") {
      try {
        bashRoots =
          requestedScope === undefined
            ? agentBashRoots(executionCwd, writeScopeFor(requestedCwd, executionCwd))
            : [...requestBashRoots(requestedScope), ...fixedLandlockRoots];
      } catch (error) {
        return routeError(c, error, 400);
      }
    }
    return runExecution(c, toolName, request, executionCwd, bashRoots);
  };

  const runExecution = async (
    c: Context,
    toolName: string,
    request: ValidatedExecuteRequest,
    executionCwd: string,
    bashRoots: LandlockWriteRoot[] | undefined,
  ): Promise<Response> => {
    const { toolCallId, params, requestedCwd, requestedGitConfig, requestedScope, networkAccess } = request;
    let { injected } = request;
    // gitConfig を省略する実行 (serve や旧 BFF など) からは従来どおり予約名を剥がさない。
    let gitConfigFailure: string | undefined;
    if (toolName === "bash" && requestedGitConfig !== undefined) {
      injected = withoutGitIdentityEnv(injected);
      gitConfigFailure = await queueGitPrepare(requestedGitConfig, bashRoots ?? []);
      if (!gitConfigFailure) {
        injected = { ...injected, GIT_CONFIG_GLOBAL: gitTarget.path, GIT_CONFIG_NOSYSTEM: "1" };
      }
    }
    // env 展開は bash 専用。他のツールに秘密値の経路を増やさない。
    // リクエストごとの env・scope・networkAccess を固定してしまわないよう、指定があるときは定義を共有しない。
    const definition =
      toolName === "bash" && (injected !== undefined || requestedScope !== undefined || networkAccess !== undefined)
        ? bashFor(executionCwd, bashRoots ?? [], injected, networkAccess !== false)
        : registryFor(executionCwd, writeScopeFor(requestedCwd, executionCwd)).get(toolName);
    if (!definition) {
      return c.json({ error: `Unknown tool: ${toolName}` }, 404);
    }
    const executionId = randomUUID();
    const abort = new AbortController();
    executions.set(executionId, abort);

    const encoder = new TextEncoder();
    let closed = false;
    const write = (event: SandboxEvent): boolean => {
      if (closed) return false;
      try {
        controller.enqueue(encoder.encode(encodeSandboxEvent(event)));
        return true;
      } catch {
        return false;
      }
    };

    // クライアント切断 (BFF 死亡・cancel 前の abort) でも実行を止める。
    const signal = c.req.raw.signal;
    const onClientAbort = () => abort.abort();
    signal?.addEventListener("abort", onClientAbort, { once: true });

    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        void (async () => {
          write({ type: "start", executionId });
          const onUpdate: ExecuteUpdateCallback = (payload) => {
            write({ type: "update", payload: { content: payload?.content, details: payload?.details } });
          };
          try {
            // Landlock が使えない環境では bash を実行しない (SDK の無制限な既定 shell へ落とさない)
            if (toolName === "bash") {
              const reason = await bashUnavailableReason();
              if (reason) throw new Error(`bash を実行できません: ${reason}`);
            }
            // アプリの gitconfig を書けないときは、identity を必要とする bash だけを止める
            // (read / write / serve と gitConfig の無い旧 BFF の実行は続ける)。
            if (gitConfigFailure) throw new Error(`bash を実行できません: ${gitConfigFailure}`);
            if (toolName === "bash" && requestedGitConfig !== undefined) {
              await checkGitOwnership(executionCwd, requestedCwd);
            }
            const runTool = async () => {
              throwIfAborted(abort.signal);
              const ctx = { cwd: executionCwd } as Parameters<AnyToolDefinition["execute"]>[4];
              return definition.execute(
                normalizeToolCallId(toolCallId),
                (params ?? {}) as Record<string, never>,
                abort.signal,
                onUpdate,
                ctx,
              );
            };
            const result = await runToolWithGate(runTool, toolName, params, executionCwd);
            write({
              type: "result",
              payload: {
                content: result?.content ?? [],
                details: result?.details,
              },
            });
          } catch (error) {
            write({ type: "error", message: messageFor(error) });
          } finally {
            executions.delete(executionId);
            signal?.removeEventListener("abort", onClientAbort);
            closed = true;
            try {
              controller.close();
            } catch {
              // cancel() で既に閉じている
            }
          }
        })();
      },
      cancel() {
        // BFF がストリームを読み捨てた (切断・abort) 場合も実行を止める。
        closed = true;
        abort.abort();
        executions.delete(executionId);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  };

  return {
    execute,
    executions,
    listToolNames: () => [...registryFor(rootCwd, writeScopeFor("", rootCwd)).keys()],
    landlockStatus,
    startupGitPrepare,
    gitConfigStatus,
    close: () => {
      for (const abort of executions.values()) abort.abort();
      executions.clear();
    },
  };
}
