/**
 * BFF 側で pi SDK に登録する「リモート実行ツール」定義。
 *
 * ツールのメタデータ (名前 / 説明 / パラメータスキーマ) はローカルで生成した
 * SDK 組込みツール定義からそのまま借り、execute() だけをサンドボックスの
 * ツール実行API へのプロキシに差し替える。grep / find が BFF ローカルで
 * rg / fd を起動しないよう、検索も含めてすべてサンドボックス側で完結させる。
 *
 * BFF はこのプロキシ以外の作業用ツールを持たない (ローカルファイル操作への
 * フォールバックはない)。PI_AGENT_TOOLS で未知の名前を指定された場合は
 * 設定ミスとして例外にする。
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

/** サンドボックスで実行可能なツール名 (service.ts の提供リストと一致させる)。 */
export const REMOTE_TOOL_NAMES = ["bash", "read", "edit", "write", "grep", "find", "ls"] as const;

export type RemoteToolName = (typeof REMOTE_TOOL_NAMES)[number];

type AnyToolDefinition = ToolDefinition<any, any, any>;
type RemoteToolFactory = (cwd: string) => AnyToolDefinition;

/** サンドボックスに存在しないツール名 (BFF のプラットフォーム判定由来の powershell など)。 */
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
  /** BFF 側の論理 cwd (サンドボックスの作業領域と同じパスを指す。パス変換は不要)。 */
  cwd: string;
  client: SandboxToolClient;
  masker: SecretMasker;
  /** 登録するツール名 (PI_AGENT_TOOLS 由来)。 */
  tools: readonly string[];
}

/**
 * リモート実行ツール定義を作る。戻り値は customTools として SDK へ渡す。
 * 全て秘密マスクで包む (途中出力・最終結果・エラー)。
 */
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
            // ctx (BFF 側の実ファイルシステム) は引き渡さない。サンドボックス側の
            // cwd / ファイルシステムだけがパスの解決源。
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
