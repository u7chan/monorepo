/**
 * 保護対象の秘密値を BFF の環境変数から集め、pi SDK の公開 API
 * (ツール定義の execute、インライン拡張の tool_result) へマスクを差し込む glue。
 *
 * 作業用ツールはサンドボックス (server/src/sandbox/) で実行されるため、BFF は
 * 子プロセスを起こさない。環境変数の許可リスト (旧 child-env.ts) はリモート化で
 * 役目を終え、BFF は出力マスクだけを担う。
 */
import { type InlineExtension, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";
import { createSecretMasker, MIN_SECRET_LENGTH, maskTextContentParts, type SecretMasker } from "./redact";

type AnyToolDefinition = ToolDefinition<any, any, any>;
type ShellExecute = AnyToolDefinition["execute"];
type ShellUpdateCallback = NonNullable<Parameters<ShellExecute>[3]>;
type ShellPartialResult = Parameters<ShellUpdateCallback>[0];

/**
 * findEnvKeys が解決しない既知プロバイダーのキー変数の補完。
 * pi-ai のキー変数解決は AWS の ambient 認証情報を意図的に除外しているが、
 * Bedrock ベアラートークンは API キーと同種の直接認証値なので保護対象に入れる。
 * (AWS_ACCESS_KEY_ID などの IAM 認証情報と OAuth トークンは対象外)
 */
const SUPPLEMENTAL_PROVIDER_ENV_KEYS: Record<string, readonly string[]> = {
  "amazon-bedrock": ["AWS_BEARER_TOKEN_BEDROCK"],
};

/**
 * ランタイムが知っている各プロバイダーについて、認証に使われる環境変数
 * (pi-ai の findEnvKeys が解決し、上記の補完で欠けを埋める) のうち設定
 * されているものを集め、その値を保護対象として返す。重複値は除かれる。
 *
 * 自動解決された値は短すぎると通常出力を過剰に改変するため MIN_SECRET_LENGTH
 * 未満を対象外にする。extraVarNames (PI_SECRET_ENV_VARS) で明示指定された
 * 変数は運用者の意図なので長さに関係なく保護する。
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
 * 全ツールの最終結果を、LLM・履歴・イベントへ渡る前にマスクする
 * インライン拡張。ツール定義の外からは観測できない出力もここで一括して掛かる。
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
