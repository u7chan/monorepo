import { CODEX_NAME } from "./codex";
import { OPENCODE_NAME } from "./opencode-go";
import type { ProviderId } from "./types";

export type ProviderDefinition = { id: ProviderId; name: string };

export const CODEX_PROVIDER: ProviderDefinition = { id: "codex", name: CODEX_NAME };
export const OPENCODE_PROVIDER: ProviderDefinition = { id: "opencode-go", name: OPENCODE_NAME };
