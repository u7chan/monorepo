/**
 * 保護対象の秘密値を環境変数から集め、pi SDK の公開 API (ツール定義の execute、インライン拡張の tool_result) へマスクを差し込む glue。
 * 作業用ツールはサンドボックスで実行されるため BFF は子プロセスを起こさず、出力マスクだけを担う。
 */
import { type InlineExtension, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";
import { createSecretMasker, MIN_SECRET_LENGTH, maskTextContentParts, type SecretMasker } from "./redact";

type AnyToolDefinition = ToolDefinition<any, any, any>;
type ShellExecute = AnyToolDefinition["execute"];
type ShellUpdateCallback = NonNullable<Parameters<ShellExecute>[3]>;
type ShellPartialResult = Parameters<ShellUpdateCallback>[0];

/**
 * findEnvKeys が解決しない既知プロバイダーのキー変数の補完。pi-ai は AWS の ambient 認証情報を意図的に除外しているが、
 * Bedrock ベアラートークンは API キーと同種の直接認証値なので保護対象に入れる (IAM 認証情報と OAuth トークンは対象外)。
 */
const SUPPLEMENTAL_PROVIDER_ENV_KEYS: Record<string, readonly string[]> = {
  "amazon-bedrock": ["AWS_BEARER_TOKEN_BEDROCK"],
};

/**
 * 各プロバイダーの認証用環境変数のうち設定されている値を保護対象として返す (重複は除く)。
 * MIN_SECRET_LENGTH 未満は自動解決された値にだけ適用し、PI_SECRET_ENV_VARS の明示指定は長さに関係なく保護する。
 * models.json 等の独自プロバイダーは findEnvKeys が解決できないため、その場合は明示指定で追加する。
 */
export function collectSecretValues(
  providers: readonly { id: string }[],
  env: NodeJS.ProcessEnv,
  extraVarNames: readonly string[] = [],
): string[] {
  // findEnvKeys の ProviderEnv は値が必須の Record だが、実装は undefined を受け付けるため process.env をそのまま渡す。
  const providerEnv = env as unknown as Parameters<typeof findEnvKeys>[1];
  const explicitNames = new Set(extraVarNames);
  const values = new Set<string>();
  const take = (name: string, explicit: boolean): void => {
    const value = env[name];
    if (typeof value !== "string" || value.trim() === "") return;
    if (!explicit && value.length < MIN_SECRET_LENGTH) return;
    values.add(value);
  };
  for (const provider of providers) {
    const names = findEnvKeys(provider.id, providerEnv) ?? SUPPLEMENTAL_PROVIDER_ENV_KEYS[provider.id] ?? [];
    for (const name of names) {
      take(name, explicitNames.has(name));
    }
  }
  for (const name of explicitNames) take(name, true);
  return [...values];
}

/** PI_SECRET_ENV_VARS (カンマ区切り) で追加された変数名 */
export function extraSecretVarNames(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PI_SECRET_ENV_VARS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
}

/** メッセージに秘密値が含まれるときだけ、マスクした Error に差し替える。 */
function throwMasked(error: unknown, masker: SecretMasker): never {
  const message = error instanceof Error ? error.message : String(error);
  const masked = masker.mask(message);
  if (masked === message) throw error;
  throw new Error(masked);
}

/**
 * 途中出力 (onUpdate)・最終結果・エラーをマスクする。最終結果は tool_result 拡張でも二重にマスクされるが、
 * 途中出力はツール定義の外から観測できないため、ここでしか掛けられない。
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
            // bash / powershell の途中出力は「ここまでの累積スナップショット」なので、
            // 末尾が秘密の前方一致になる分を保留し、生の完全体が複数の更新に分かれて流れないようにする。
            onUpdate({
              ...partialResult,
              content: maskTextContentParts(partialResult.content, masker, { mode: "accumulated" }),
            });
          }
        : undefined;
      try {
        const result = await definition.execute(toolCallId, params, signal, maskedOnUpdate, ctx);
        return { ...result, content: maskTextContentParts(result?.content, masker, { mode: "final" }) };
      } catch (error) {
        return throwMasked(error, masker);
      }
    },
  };
}

/**
 * 全ツールの最終結果を、LLM・履歴・イベントへ渡る前にマスクするインライン拡張。
 * ツール定義の外からは観測できない出力もここで一括して掛かる。
 */
export function createSecretRedactionExtension(masker: SecretMasker): InlineExtension {
  return (pi) => {
    pi.on("tool_result", async (event) => ({
      content: maskTextContentParts(event.content, masker, { mode: "final" }),
    }));
  };
}

/** BFF 全体で使うマスカー。モデルランタイムが知るプロバイダーを解決源にする。 */
export function createRuntimeSecretMasker(providers: readonly { id: string }[], env: NodeJS.ProcessEnv): SecretMasker {
  return createSecretMasker(collectSecretValues(providers, env, extraSecretVarNames(env)));
}
