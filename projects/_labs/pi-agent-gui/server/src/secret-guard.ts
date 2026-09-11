/**
 * 保護対象の秘密値を BFF の環境変数から集め、pi SDK の公開 API
 * (ツール定義の spawnHook / execute、インライン拡張の tool_result) へ
 * マスクを差し込む glue。
 */
import {
  createBashToolDefinition,
  createPowerShellToolDefinition,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";
import { buildChildEnv } from "./child-env";
import { createSecretMasker, maskTextContentParts, type SecretMasker } from "./redact";

/** シェルツールが子プロセスへ渡す前に許可リストへ絞るための hook 引数。 */
interface SpawnContext {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

type AnyToolDefinition = ToolDefinition<any, any, any>;
type ShellExecute = AnyToolDefinition["execute"];
type ShellUpdateCallback = NonNullable<Parameters<ShellExecute>[3]>;
type ShellPartialResult = Parameters<ShellUpdateCallback>[0];

/**
 * ランタイムが知っている各プロバイダーについて、認証に使われる環境変数
 * (pi-ai の findEnvKeys が解決) のうち設定されているものを集め、その値を
 * 保護対象として返す。重複値は除かれる。
 *
 * models.json 等で独自プロバイダーを使う場合は findEnvKeys が解決できない
 * ため、PI_SECRET_ENV_VARS (カンマ区切りの変数名) で追加する。
 */
export function collectSecretValues(
  providers: readonly { id: string }[],
  env: NodeJS.ProcessEnv,
  extraVarNames: readonly string[] = [],
): string[] {
  // findEnvKeys の ProviderEnv は値が必須の Record だが、実装は undefined を
  // 受け付けるため process.env をそのまま渡す。
  const providerEnv = env as unknown as Parameters<typeof findEnvKeys>[1];
  const names = new Set<string>();
  for (const provider of providers) {
    for (const name of findEnvKeys(provider.id, providerEnv) ?? []) {
      names.add(name);
    }
  }
  for (const name of extraVarNames) names.add(name);
  const values: string[] = [];
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim() !== "") values.push(value);
  }
  return values;
}

/** PI_SECRET_ENV_VARS (カンマ区切り) で保護対象に追加された環境変数名。 */
export function extraSecretVarNames(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PI_SECRET_ENV_VARS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
}

/** エラーのメッセージに秘密値が含まれる場合のみ、マスクした Error に差し替える。 */
function throwMasked(error: unknown, masker: SecretMasker): never {
  const message = error instanceof Error ? error.message : String(error);
  const masked = masker.mask(message);
  if (masked === message) throw error;
  throw new Error(masked);
}

/**
 * ツール定義を包み、途中出力 (onUpdate)・最終結果・エラーをマスクする。
 * 最終結果は tool_result 拡張でも二重にマスクされるが、途中出力は
 * ツール定義の外からは観測できないため、ここでしか掛けられない。
 */
export function wrapToolDefinitionWithSecretMasker(
  definition: AnyToolDefinition,
  masker: SecretMasker,
): AnyToolDefinition {
  return {
    ...definition,
    async execute(
      toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      onUpdate: ShellUpdateCallback | undefined,
      ctx: Parameters<ShellExecute>[4],
    ) {
      const maskedOnUpdate: ShellUpdateCallback | undefined = onUpdate
        ? (partialResult: ShellPartialResult) => {
            // bash / powershell の途中出力は「ここまでの累積スナップショット」。
            // 末尾が秘密の前方一致になる分は保留し、生の完全体が複数回の
            // 更新に分かれて流れないようにする。
            onUpdate({
              ...partialResult,
              content: maskTextContentParts(partialResult.content, masker, { accumulated: true }),
            });
          }
        : undefined;
      try {
        const result = await definition.execute(toolCallId, params, signal, maskedOnUpdate, ctx);
        return { ...result, content: maskTextContentParts(result?.content, masker) };
      } catch (error) {
        return throwMasked(error, masker);
      }
    },
  };
}

/**
 * bash / powershell ツールを、子プロセスの環境変数を許可リストへ絞る
 * spawnHook 付きで作り直し、出力のマスクで包む。同名の組み込みツールは
 * customTools として登録した定義で置き換わる。
 */
export function createGuardedShellToolDefinitions(
  cwd: string,
  masker: SecretMasker,
  extraEnvNames: readonly string[] = [],
): ToolDefinition[] {
  const spawnHook = (context: SpawnContext): SpawnContext => ({
    ...context,
    env: buildChildEnv(context.env, extraEnvNames),
  });
  return [
    wrapToolDefinitionWithSecretMasker(createBashToolDefinition(cwd, { spawnHook }), masker),
    wrapToolDefinitionWithSecretMasker(createPowerShellToolDefinition(cwd, { spawnHook }), masker),
  ];
}

/**
 * 全ツールの最終結果を、LLM・履歴・イベントへ渡る前にマスクする
 * インライン拡張。シェル以外のツール (read / grep / 独自ツール) の出力も
 * ここで一括して掛かる。
 */
export function createSecretRedactionExtension(masker: SecretMasker): InlineExtension {
  return (pi) => {
    pi.on("tool_result", async (event) => ({
      content: maskTextContentParts(event.content, masker),
    }));
  };
}

/** BFF 全体で使うマスカー。モデルランタイムが知るプロバイダーを解決源にする。 */
export function createRuntimeSecretMasker(providers: readonly { id: string }[], env: NodeJS.ProcessEnv): SecretMasker {
  return createSecretMasker(collectSecretValues(providers, env, extraSecretVarNames(env)));
}
