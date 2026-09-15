/**
 * サンドボックス ツール実行サービス (HTTP)。SDK の作業用ツールをこのプロセスのローカル実装で実行し、結果を NDJSON で返す。
 * LLM 認証情報をこのプロセスの環境へ入れないことはデプロイ側の前提 (サービス自身が剥がすのは共有トークンだけ)。
 * /v1/* は未認証を 401 で拒否し、/healthz だけは Compose healthcheck 用に無認証で開ける。
 */
import { timingSafeEqual, createHash, randomUUID } from "node:crypto";
import { realpath as realpathCallback, type Dirent } from "node:fs";
import { lstat, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type BashSpawnContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Hono } from "hono";
import {
  SANDBOX_MAX_BODY_BYTES,
  SANDBOX_MAX_FILE_ENTRIES,
  encodeSandboxEvent,
  type SandboxCreateDirRequestBody,
  type SandboxExecuteRequestBody,
  type SandboxEvent,
  type SandboxFileEntry,
  type SandboxFileListing,
} from "./protocol";

/** サンドボックスが提供する作業用ツール名 (bash のみローカル出力をストリームする) */
export const SANDBOX_TOOL_NAMES = ["bash", "read", "edit", "write", "grep", "find", "ls"] as const;

type AnyToolDefinition = ToolDefinition<any, any, any>;
type ExecuteUpdateCallback = NonNullable<Parameters<AnyToolDefinition["execute"]>[3]>;

export interface SandboxServiceOptions {
  /** 空や短すぎる値はここで弾く */
  token: string;
  rootCwd?: string;
}

export interface SandboxService {
  app: Hono;
  executions: Map<string, AbortController>;
  close: () => void;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 長さを漏らさないための定数時間比較 (sha256 で同じ長さに揃える)。 */
function tokensEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function normalizeToolCallId(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : randomUUID();
}

/**
 * カーネルと同じ解決順 (symlink を辿ってから `..` を適用する) で実パスを返す。
 * 解決前に `..` を path.resolve で字句的に畳んではならない (例: root/linkOutside -> outside/nested で
 * root/linkOutside/.. は outside)。非 native の fs.realpath / fs.realpathSync も同じ字句畳みをするため native を使う。
 */
function realpathNative(target: string): Promise<string> {
  return new Promise((resolvePath, rejectPath) => {
    realpathCallback.native(target, (error, resolved) => {
      if (error) rejectPath(error);
      else resolvePath(resolved);
    });
  });
}

/** 要求パスを字句正規化せずに root へ連結する (`..` の適用は realpath に任せる)。 */
function joinRequestPath(root: string, requested: string): string {
  if (!requested) return root;
  return isAbsolute(requested) ? requested : `${root}${sep}${requested}`;
}

/** 上限を超えたボディは 413。 */
async function readJsonBody(request: Request): Promise<unknown> {
  const body = request.body;
  if (!body) return {};
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > SANDBOX_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  const trimmed = text.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  return parsed;
}

/**
 * root 相対の要求パスを解決し、実在するディレクトリで root 配下であることを検証する。
 * ツール実行の cwd と一覧の共通の入口で、`..` の適用順はカーネル (symlink → `..`) に合わせる。
 */
async function resolveWorkspaceDirectory(
  rootCwd: string,
  requested: string,
): Promise<{ root: string; target: string }> {
  // root 自体も realpath で解決し、両辺を実パスで比較する (root の symlink 経由でも判定が崩れないように)
  const root = await realpathNative(rootCwd).catch((error: unknown) => {
    throw pathError(500, `Cannot resolve the sandbox workspace: ${messageFor(error)}`);
  });

  // メッセージ表示と、実在しない要求の lexical 判定に使う字句正規化済みのパス
  let candidate: string;
  try {
    candidate = resolve(root, requested || ".");
  } catch {
    throw pathError(400, `Invalid path: ${requested}`);
  }

  // 字句的に畳んでから realpath へ渡すと `..` が symlink より先に適用され、カーネルの解決順とずれる。
  // 生の要求パスを native realpath (realpath(3)) に渡し、symlink を辿ってから `..` を解決させる。
  const target = await realpathNative(joinRequestPath(root, requested)).catch((error: unknown) => {
    // 解決できない = 実在しない (か解決不能) なので、lexical な位置で判定する。
    // root 外の未作成パスを 404 にすると「root 外は 400」の入力検証が抜ける。
    if (!isInsideRoot(root, candidate)) throw pathError(400, `Path outside the workspace: ${candidate}`);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw pathError(404, `Path not found: ${candidate}`);
    throw pathError(400, `Cannot resolve path: ${messageFor(error)}`);
  });
  if (!isInsideRoot(root, target)) throw pathError(400, `Path outside the workspace: ${target}`);

  const targetStat = await stat(target).catch(() => undefined);
  if (!targetStat) throw pathError(404, `Path not found: ${candidate}`);
  if (!targetStat.isDirectory()) throw pathError(400, `Not a directory: ${candidate}`);
  return { root, target };
}

/**
 * root 相対のディレクトリを mkdir -p 相当で作る。既存ディレクトリは成功扱い。
 * 作成前に既存の最も深い祖先を realpath で検証し、root 外を指す symlink を経由した作成を防ぐ。
 */
async function createWorkspaceDirectory(rootCwd: string, requested: string): Promise<string> {
  const root = await realpathNative(rootCwd).catch((error: unknown) => {
    throw pathError(500, `Cannot resolve the sandbox workspace: ${messageFor(error)}`);
  });

  let candidate: string;
  try {
    candidate = resolve(root, requested || ".");
  } catch {
    throw pathError(400, `Invalid path: ${requested}`);
  }
  if (!isInsideRoot(root, candidate)) throw pathError(400, `Path outside the workspace: ${candidate}`);

  const ancestor = await deepestExistingPath(candidate);
  const realAncestor = await realpathNative(ancestor).catch((error: unknown) => {
    throw pathError(400, `Cannot resolve path: ${messageFor(error)}`);
  });
  if (!isInsideRoot(root, realAncestor)) throw pathError(400, `Path outside the workspace: ${realAncestor}`);

  await mkdir(candidate, { recursive: true }).catch((error: unknown) => {
    throw pathError(400, `Cannot create directory: ${messageFor(error)}`);
  });

  // 作成後に実パスで再検証する (途中の symlink が root 外を指していた場合を取り逃さない)
  const target = await realpathNative(candidate).catch((error: unknown) => {
    throw pathError(400, `Cannot resolve path: ${messageFor(error)}`);
  });
  if (!isInsideRoot(root, target)) throw pathError(400, `Path outside the workspace: ${target}`);
  const targetStat = await stat(target).catch(() => undefined);
  if (!targetStat?.isDirectory()) throw pathError(400, `Not a directory: ${candidate}`);
  return relativeToRoot(root, target);
}

/** 実在する最も深い祖先 (自身を含む)。root 配下の要求では必ず root 以前で止まる。 */
async function deepestExistingPath(target: string): Promise<string> {
  let current = target;
  for (;;) {
    const exists = await stat(current)
      .then(() => true)
      .catch(() => false);
    if (exists) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function pathError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * root 相対の要求パスを解決して一覧を返す。root 内外は「`..` の有無」ではなく realpath で解決した実パスで判定するため、
 * root 外にある symlink (`../link-in` など) から root 内へ解決する要求も 200 になる。
 * エラー文言は SDK の ls ツールに寄せる (BFF はサンドボックスの文言をそのままクライアントへ返す)。
 */
async function listWorkspaceDirectory(rootCwd: string, requested: string): Promise<SandboxFileListing> {
  const { root, target } = await resolveWorkspaceDirectory(rootCwd, requested);

  const dirents = await readdir(target, { withFileTypes: true }).catch((error: unknown) => {
    throw pathError(400, `Cannot read directory: ${messageFor(error)}`);
  });
  // 並び替え (ディレクトリ先 → ファイル) には実体の種別が要るため、先に symlink だけ辿る。
  // 件数上限を超える巨大ディレクトリでも stat は上限件数にしか掛けない。
  const candidates = await Promise.all(dirents.map((dirent) => classifyEntry(target, dirent)));
  candidates.sort(compareEntries);
  const truncated = candidates.length > SANDBOX_MAX_FILE_ENTRIES;

  const entries: SandboxFileEntry[] = [];
  for (const candidateEntry of candidates.slice(0, SANDBOX_MAX_FILE_ENTRIES)) {
    const entryPath = join(target, candidateEntry.name);
    const entry: SandboxFileEntry = { name: candidateEntry.name, type: candidateEntry.type };
    if (candidateEntry.symlink) entry.symlink = true;
    if (candidateEntry.type === "file") {
      // symlink は辿った先、通常ファイルは lstat。壊れた symlink は size / mtime なしで返す
      const stats = await (candidateEntry.symlink ? stat : lstat)(entryPath).catch(() => undefined);
      if (stats) {
        entry.size = stats.size;
        entry.mtime = Math.round(stats.mtimeMs);
      }
    }
    entries.push(entry);
  }

  return {
    // 解決後の実ディレクトリを root 相対で返す (root 外の別名から解決した場合も root 内のパスになる)
    path: relativeToRoot(root, target),
    entries,
    truncated,
  };
}

function isInsideRoot(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** symlink は辿った先の種別に寄せる (壊れた symlink は file として出す)。 */
async function classifyEntry(
  dirPath: string,
  dirent: Dirent,
): Promise<{ name: string; type: "file" | "dir"; symlink: boolean }> {
  const name = dirent.name;
  if (!dirent.isSymbolicLink()) {
    return { name, type: dirent.isDirectory() ? "dir" : "file", symlink: false };
  }
  const followed = await stat(join(dirPath, name)).catch(() => undefined);
  return { name, type: followed?.isDirectory() ? "dir" : "file", symlink: true };
}

/** ディレクトリ先 → ファイル、各グループ内は大文字小文字を無視した昇順 (同順はコード順で安定させる)。 */
function compareEntries(a: { name: string; type: "file" | "dir" }, b: { name: string; type: "file" | "dir" }): number {
  if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
  const ignoringCase = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  if (ignoringCase !== 0) return ignoringCase;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** root 相対の正規化パス。区切りは常に "/" (root は ".")。 */
function relativeToRoot(root: string, target: string): string {
  const rel = relative(root, target);
  if (!rel) return ".";
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/** listen は呼び出し側 (@hono/node-server) が行い、テストは app.request() で検証する。 */
export function createSandboxService(options: SandboxServiceOptions): SandboxService {
  const token = options.token;
  if (!token || token.trim().length < 16) {
    throw new Error("PI_SANDBOX_TOKEN must be set to a non-trivial value (16+ chars)");
  }
  const rootCwd = options.rootCwd || "/workspace";

  // bash にはセッションメタ変数 (PI_SESSION_ID 等) を注入せず (サンドボックスにセッションは無い)、
  // SDK の bash が process.env を継承しても、このプロセスの唯一の秘密値である共有トークンだけは剥がす。
  const stripSandboxToken = (context: BashSpawnContext): BashSpawnContext => {
    const env: NodeJS.ProcessEnv = { ...context.env };
    delete env.PI_SANDBOX_TOKEN;
    return { ...context, env };
  };

  /**
   * cwd ごとのツール定義。パス解決の起点が定義に焼き込まれるため、実行 cwd ごとに生成して再利用する。
   * key は realpath 解決済みの絶対パス (symlink 経由の別名で重複生成しない)。
   */
  const registries = new Map<string, Map<string, AnyToolDefinition>>();
  const registryFor = (cwd: string): Map<string, AnyToolDefinition> => {
    const cached = registries.get(cwd);
    if (cached) return cached;
    const definitions: AnyToolDefinition[] = [
      createBashToolDefinition(cwd, {
        exposeSessionEnvironment: false,
        spawnHook: stripSandboxToken,
      }),
      createReadToolDefinition(cwd),
      createEditToolDefinition(cwd),
      createWriteToolDefinition(cwd),
      createGrepToolDefinition(cwd),
      createFindToolDefinition(cwd),
      createLsToolDefinition(cwd),
    ];
    const registry = new Map<string, AnyToolDefinition>(definitions.map((def) => [def.name, def]));
    registries.set(cwd, registry);
    return registry;
  };

  const executions = new Map<string, AbortController>();

  const app = new Hono();

  app.get("/healthz", (c) => {
    return c.json({
      ok: true,
      tools: [...registryFor(rootCwd).keys()],
      cwd: rootCwd,
      runningExecutions: executions.size,
    });
  });

  // /v1/* は Bearer 認証を要求する (未認証はここで 401 になる)
  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer (.+)$/.exec(header);
    if (!match || !tokensEqual(match[1], token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.post("/v1/tools/:tool/execute", async (c) => {
    const toolName = c.req.param("tool") ?? "";
    // 定義は cwd ごとに生成するため、未知のツールは名前だけで先に弾く
    if (!(SANDBOX_TOOL_NAMES as readonly string[]).includes(toolName)) {
      return c.json({ error: `Unknown tool: ${toolName}` }, 404);
    }
    let body: unknown;
    try {
      body = await readJsonBody(c.req.raw);
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
    const { toolCallId, params, cwd } = (body ?? {}) as SandboxExecuteRequestBody;
    if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
      return c.json({ error: "params must be an object" }, 400);
    }
    if (cwd !== undefined && typeof cwd !== "string") {
      return c.json({ error: "cwd must be a string" }, 400);
    }
    // 実行 cwd はリクエストごとに root 配下の実在ディレクトリへ解決する (実行時隔離ではなくパス解決の起点)
    let executionCwd: string;
    try {
      executionCwd = (await resolveWorkspaceDirectory(rootCwd, cwd ?? "")).target;
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
    const definition = registryFor(executionCwd).get(toolName);
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
            const ctx = { cwd: executionCwd } as Parameters<AnyToolDefinition["execute"]>[4];
            const result = await definition.execute(
              normalizeToolCallId(toolCallId),
              (params ?? {}) as Record<string, never>,
              abort.signal,
              onUpdate,
              ctx,
            );
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
  });

  app.get("/v1/files", async (c) => {
    try {
      return c.json(await listWorkspaceDirectory(rootCwd, c.req.query("path") ?? ""));
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  app.post("/v1/dirs", async (c) => {
    let body: unknown;
    try {
      body = await readJsonBody(c.req.raw);
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
    const { path } = (body ?? {}) as SandboxCreateDirRequestBody;
    if (typeof path !== "string") {
      return c.json({ error: "path must be a string" }, 400);
    }
    try {
      return c.json({ path: await createWorkspaceDirectory(rootCwd, path) });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  app.post("/v1/executions/:id/cancel", (c) => {
    const id = c.req.param("id") ?? "";
    const abort = executions.get(id);
    if (!abort) {
      return c.json({ error: "Execution not found" }, 404);
    }
    abort.abort();
    return c.json({ ok: true });
  });

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  return {
    app,
    executions,
    close: () => {
      for (const abort of executions.values()) abort.abort();
      executions.clear();
    },
  };
}
