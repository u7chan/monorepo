/**
 * サンドボックス ツール実行サービス (HTTP)。SDK の作業用ツールをこのプロセスのローカル実装で実行し、結果を NDJSON で返す。
 * LLM 認証情報をこのプロセスの環境へ入れないことはデプロイ側の前提 (サービス自身が剥がすのは共有トークンだけ)。
 * /v1/* は未認証を 401 で拒否し、/healthz だけは Compose healthcheck 用に無認証で開ける。
 */
import { timingSafeEqual, createHash, randomUUID } from "node:crypto";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
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
  /** Bearer トークン (空や短すぎる値はここで弾く) */
  token: string;
  /** ツール実行の既定 cwd (サンドボックス内の作業領域) */
  rootCwd?: string;
}

export interface SandboxService {
  app: Hono;
  /** 実行中の executionId → AbortController (診断・テスト用) */
  executions: Map<string, AbortController>;
  /** 全実行を中断して終了する (shutdown 用) */
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
 * root 相対の要求パスを解決して一覧を返す。判定は「`..` の有無」ではなく「realpath した実パスが root 内か」で行い、
 * root 外を指す symlink も一覧には出すが、その位置を開こうとした時点で 400 にする。
 * エラー文言は SDK の ls ツールに寄せる (BFF はサンドボックスの文言をそのままクライアントへ返す)。
 */
async function listWorkspaceDirectory(rootCwd: string, requested: string): Promise<SandboxFileListing> {
  const fail = (statusCode: number, message: string): never => {
    throw Object.assign(new Error(message), { statusCode });
  };

  // root 自体も realpath で解決し、両辺を実パスで比較する (root の symlink 経由でも判定が崩れないように)
  const root = await realpath(rootCwd).catch((error: unknown) =>
    fail(500, `Cannot resolve the sandbox workspace: ${messageFor(error)}`),
  );

  let candidate: string;
  try {
    candidate = resolve(root, requested || ".");
  } catch {
    return fail(400, `Invalid path: ${requested}`);
  }
  if (!isInsideRoot(root, candidate)) return fail(400, `Path outside the workspace: ${candidate}`);

  const target = await realpath(candidate).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return fail(404, `Path not found: ${candidate}`);
    return fail(400, `Cannot resolve path: ${messageFor(error)}`);
  });
  // 途中の symlink が root 外を指していた場合もここで弾く
  if (!isInsideRoot(root, target)) return fail(400, `Path outside the workspace: ${target}`);

  const targetStat = await stat(target).catch(() => undefined);
  if (!targetStat) return fail(404, `Path not found: ${candidate}`);
  if (!targetStat.isDirectory()) return fail(400, `Not a directory: ${candidate}`);

  const dirents = await readdir(target, { withFileTypes: true }).catch((error: unknown) =>
    fail(400, `Cannot read directory: ${messageFor(error)}`),
  );
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
    path: relativeToRoot(root, candidate),
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
function compareEntries(
  a: { name: string; type: "file" | "dir" },
  b: { name: string; type: "file" | "dir" },
): number {
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

  const definitions: AnyToolDefinition[] = [
    createBashToolDefinition(rootCwd, {
      exposeSessionEnvironment: false,
      spawnHook: stripSandboxToken,
    }),
    createReadToolDefinition(rootCwd),
    createEditToolDefinition(rootCwd),
    createWriteToolDefinition(rootCwd),
    createGrepToolDefinition(rootCwd),
    createFindToolDefinition(rootCwd),
    createLsToolDefinition(rootCwd),
  ];
  const registry = new Map<string, AnyToolDefinition>(definitions.map((def) => [def.name, def]));

  const executions = new Map<string, AbortController>();

  const app = new Hono();

  app.get("/healthz", (c) => {
    return c.json({
      ok: true,
      tools: [...registry.keys()],
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
    const definition = registry.get(toolName);
    if (!definition) {
      return c.json({ error: `Unknown tool: ${toolName}` }, 404);
    }
    let body: unknown;
    try {
      body = await readJsonBody(c.req.raw);
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
    const { toolCallId, params } = (body ?? {}) as SandboxExecuteRequestBody;
    if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
      return c.json({ error: "params must be an object" }, 400);
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
            const ctx = { cwd: rootCwd } as Parameters<AnyToolDefinition["execute"]>[4];
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
