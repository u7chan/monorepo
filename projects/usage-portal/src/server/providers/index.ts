import { CODEX_NAME } from "./codex";
import { OPENCODE_NAME } from "./opencode-go";
import type { ProviderId } from "./types";

export type ProviderDefinition = { id: ProviderId; name: string };

export const CODEX_PROVIDER: ProviderDefinition = { id: "codex", name: CODEX_NAME };
export const OPENCODE_PROVIDER: ProviderDefinition = { id: "opencode-go", name: OPENCODE_NAME };

/** 画面上の並び順も兼ねる。取得に失敗しても行は残すため、設定ではなく固定の一覧にする。 */
export const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [CODEX_PROVIDER, OPENCODE_PROVIDER];
