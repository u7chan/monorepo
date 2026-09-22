/**
 * BFF 側で pi SDK に登録する「リモート実行ツール」定義。メタデータだけ SDK の組込み定義から借り、
 * execute() はサンドボックス API へのプロキシに差し替える (grep / find も含め、ローカル実行へのフォールバックは無い)。
 */
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { SandboxToolClient } from "./client";
import { catalogSkillNameForRequestedPath } from "../catalog-skills";
import { builtinSkillForRequestedPath, formatBuiltinSkillBody, formatSkillBody } from "../builtin-skills";
import { wrapToolDefinitionWithSecretMasker } from "../secret-guard";
import type { SecretMasker } from "../redact";

/** サンドボックスで実行可能なツール名 (service.ts の提供リストと一致させる) */
export const REMOTE_TOOL_NAMES = ["bash", "read", "edit", "write", "grep", "find", "ls"] as const;

export type RemoteToolName = (typeof REMOTE_TOOL_NAMES)[number];

type AnyToolDefinition = ToolDefinition<any, any, any>;
type RemoteToolFactory = (cwd: string) => AnyToolDefinition;

/** サンドボックスに無いツール名 (BFF のプラットフォーム判定由来の powershell など) */
export class UnknownRemoteToolError extends Error {
  constructor(name: string) {
    super(`サンドボックスでは実行できないツールが指定されています: ${name}`);
    this.name = "UnknownRemoteToolError";
  }
}

const TOOL_FACTORIES: Record<RemoteToolName, RemoteToolFactory> = {
  bash: (cwd) => createBashToolDefinition(cwd, { exposeSessionEnvironment: false }),
  read: (cwd) => createReadToolDefinition(cwd),
  edit: (cwd) => createEditToolDefinition(cwd),
  write: (cwd) => createWriteToolDefinition(cwd),
  grep: (cwd) => createGrepToolDefinition(cwd),
  find: (cwd) => createFindToolDefinition(cwd),
  ls: (cwd) => createLsToolDefinition(cwd),
};

export interface RemoteToolDefinitionOptions {
  /** セッションの作業ディレクトリ (絶対パス)。組込み定義のメタデータと組み込みスキルの相対パス解決に使う */
  cwd: string;
  /** ワークスペース root (絶対パス)。組み込みスキルの仮想パス (`<root>/.u7agent/builtin-skills/...`) の基準 */
  rootCwd: string;
  /** サンドボックスへ要求する作業ディレクトリ (rootCwd 相対。"" は root) */
  sandboxCwd: string;
  client: SandboxToolClient;
  masker: SecretMasker;
  /** PI_AGENT_TOOLS 由来の登録ツール名 */
  tools: readonly string[];
  /**
   * カタログ (Agent 割り当て) スキルの本文。セッションの promptSnapshot から渡し、仮想パスの read を
   * サンドボックスへ送らず BFF で返す (定義を編集・削除してもこのセッションの本文は変わらない)
   */
  catalogSkills?: readonly { name: string; body: string }[];
}

/** 戻り値は customTools として SDK へ渡す。すべて秘密マスクで包む。 */
export function createRemoteToolDefinitions(options: RemoteToolDefinitionOptions): ToolDefinition[] {
  const { cwd, rootCwd, sandboxCwd, client, masker, tools, catalogSkills = [] } = options;
  const definitions: ToolDefinition[] = [];
  for (const name of tools) {
    if (!(REMOTE_TOOL_NAMES as readonly string[]).includes(name)) {
      throw new UnknownRemoteToolError(name);
    }
    const factory = TOOL_FACTORIES[name as RemoteToolName];
    const local = factory(cwd);
    definitions.push(
      wrapToolDefinitionWithSecretMasker(
        {
          name: local.name,
          label: local.label,
          description: local.description,
          promptSnippet: local.promptSnippet,
          promptGuidelines: local.promptGuidelines,
          parameters: local.parameters,
          constrainedSampling: local.constrainedSampling,
          executionMode: local.executionMode,
          prepareArguments: local.prepareArguments,
          execute: async (toolCallId, params, signal, onUpdate, _ctx) => {
            // 組み込み / カタログスキルはワークスペースに実体が無い仮想パスなので、read だけは BFF が
            // 本文を返す。サンドボックスへ送らない (ls / grep / find / bash からは見えない)
            if (name === "read") {
              const requested = (params as { path?: unknown } | undefined)?.path;
              const page = params as { offset?: number; limit?: number };
              const builtin = builtinSkillForRequestedPath(requested, { cwd, rootCwd });
              if (builtin) {
                const text = formatBuiltinSkillBody(builtin, { offset: page.offset, limit: page.limit });
                return { content: [{ type: "text", text }] } as Awaited<ReturnType<AnyToolDefinition["execute"]>>;
              }
              // 名前が仮想パスに合っても、このセッションのスナップショットに無ければサンドボックスへ委譲する
              const catalogName = catalogSkillNameForRequestedPath(requested, { cwd, rootCwd });
              const catalog = catalogName ? catalogSkills.find((skill) => skill.name === catalogName) : undefined;
              if (catalog) {
                const text = formatSkillBody(catalog.body, { offset: page.offset, limit: page.limit });
                return { content: [{ type: "text", text }] } as Awaited<ReturnType<AnyToolDefinition["execute"]>>;
              }
            }
            // BFF 側の実ファイルシステム (ctx の cwd) は渡さず、サンドボックス側だけをパス解決の源にする。
            // セッションの cwd は rootCwd 相対で渡し、サンドボックス側で root 配下の実パスへ解決させる。
            const result = await client.execute(name, {
              toolCallId,
              params,
              cwd: sandboxCwd || undefined,
              signal,
              onUpdate: onUpdate as ((partial: { content: unknown; details?: unknown }) => void) | undefined,
            });
            return { content: result.content, details: result.details } as Awaited<
              ReturnType<AnyToolDefinition["execute"]>
            >;
          },
        } satisfies AnyToolDefinition,
        masker,
      ),
    );
  }
  return definitions;
}
