import { isInjectableEnvName } from "../env-names";
import { gitIdentityProblem } from "../git-identity";
import type { SandboxExecuteRequestBody, SandboxGitConfig, SandboxWriteScopeEntry } from "./protocol";

/** サンドボックスが提供する作業用ツール名 (bash のみローカル出力をストリームする) */
export const SANDBOX_TOOL_NAMES = ["bash", "read", "edit", "write", "grep", "find", "ls"] as const;

export interface ValidatedExecuteRequest {
  toolCallId: unknown;
  params: Record<string, unknown> | undefined;
  requestedCwd: string;
  injected: Record<string, string> | undefined;
  requestedGitConfig: SandboxGitConfig | null | undefined;
  requestedScope: SandboxWriteScopeEntry[] | undefined;
  networkAccess: boolean | undefined;
}

export function parseExecuteRequest(body: unknown): ValidatedExecuteRequest {
  const { toolCallId, params, cwd, env, writeScope, gitConfig, networkAccess } = (body ?? {}) as Partial<
    Record<keyof SandboxExecuteRequestBody, unknown>
  >;
  if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
    throw new Error("params must be an object");
  }
  if (cwd !== undefined && typeof cwd !== "string") throw new Error("cwd must be a string");
  if (networkAccess !== undefined && typeof networkAccess !== "boolean") {
    throw new Error("networkAccess must be a boolean");
  }
  return {
    toolCallId,
    params: params as Record<string, unknown> | undefined,
    requestedCwd: cwd ?? "",
    injected: parseInjectedEnv(env),
    requestedGitConfig: parseGitConfig(gitConfig),
    requestedScope: parseWriteScope(writeScope),
    networkAccess,
  };
}

/**
 * `env` の検証。BFF が登録時に名前を検証しているが、実行 API の入口としてサンドボックスでも同じ規則を見る
 * (予約名 / 起動制御名を子プロセスへ入れない)。空オブジェクトは「注入なし」と同じ扱いにする。
 */
function parseInjectedEnv(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("env must be an object");
  }
  const env: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (typeof raw !== "string") throw new Error(`env values must be strings: ${name}`);
    if (!isInjectableEnvName(name)) throw new Error(`env name is not allowed: ${name}`);
    if (raw.includes("\0")) throw new Error(`env value must not contain NUL: ${name}`);
    env[name] = raw;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * 実行要求の `gitConfig`。省略 (undefined) は旧 BFF 互換で、null は「identity なし」。
 * 値の規則は BFF の設定 API と同じく git-identity.ts を見る。
 */
function parseGitConfig(value: unknown): SandboxGitConfig | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("gitConfig must be an object or null");
  const { userName, userEmail } = value as { userName?: unknown; userEmail?: unknown };
  const problem = gitIdentityProblem({ userName, userEmail });
  if (problem) throw new Error(problem);
  return { userName: (userName as string).trim(), userEmail: (userEmail as string).trim() };
}

/**
 * `writeScope` の検証。root 相対のディレクトリと、無ければ作ってよいかの宣言だけを受け付ける。
 * BFF 内部実行 (serve) 専用で、モデルはツール引数から指定できない。
 */
function parseWriteScope(value: unknown): SandboxWriteScopeEntry[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("writeScope must be an array");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("writeScope entries must be objects");
    }
    const { path, create } = entry as { path?: unknown; create?: unknown };
    if (typeof path !== "string") throw new Error("writeScope entries need a string path");
    if (create !== undefined && typeof create !== "boolean") {
      throw new Error("writeScope create must be a boolean");
    }
    return create === true ? { path, create: true } : { path };
  });
}
