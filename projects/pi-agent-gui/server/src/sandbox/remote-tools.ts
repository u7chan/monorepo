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
  /** サンドボックスの作業領域と同じパスを指すため、パス変換は不要 */
  cwd: string;
  client: SandboxToolClient;
  masker: SecretMasker;
  /** PI_AGENT_TOOLS 由来の登録ツール名 */
  tools: readonly string[];
}

/** 戻り値は customTools として SDK へ渡す。すべて秘密マスクで包む。 */
export function createRemoteToolDefinitions(options: RemoteToolDefinitionOptions): ToolDefinition[] {
  const { cwd, client, masker, tools } = options;
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
            // BFF 側の実ファイルシステム (ctx の cwd) は渡さず、サンドボックス側だけをパス解決の源にする。
            const result = await client.execute(name, {
              toolCallId,
              params,
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
