import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const OPENCODE_KEY_FILE = "opencode-key.json";
const FILE_VERSION = 1;

export type OpenCodeKeyState = { configured: boolean; savedAt: number | null };

export type OpenCodeAuth = {
  state: () => OpenCodeKeyState;
  apiKey: () => string | null;
  save: (apiKey: string) => void;
  clear: () => void;
};

type StoredKey = { apiKey: string; savedAt: number };

/**
 * OpenCode Go の API キーは秘密なので、Codex の `auth.json` と同じ `CREDENTIAL_DIR` に置く。
 * `DATA_DIR` は履歴のバックアップ対象で、秘密を混ぜたくない。
 */
export function createOpenCodeAuth(options: { credentialDir: string; now?: () => number }): OpenCodeAuth {
  const path = join(options.credentialDir, OPENCODE_KEY_FILE);
  const now = options.now ?? Date.now;

  return {
    state() {
      const stored = readStoredKey(path);

      return { configured: stored !== null, savedAt: stored?.savedAt ?? null };
    },
    apiKey: () => readStoredKey(path)?.apiKey ?? null,
    save: (apiKey) => writeStoredKey(path, { apiKey, savedAt: now() }),
    clear: () => rmSync(path, { force: true }),
  };
}

function readStoredKey(path: string): StoredKey | null {
  let text: string;

  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(text);

    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    const { version, apiKey, savedAt } = parsed as Record<string, unknown>;

    return version === FILE_VERSION &&
      typeof apiKey === "string" &&
      apiKey !== "" &&
      typeof savedAt === "number" &&
      Number.isFinite(savedAt)
      ? { apiKey, savedAt }
      : null;
  } catch {
    return null;
  }
}

/**
 * 一時ファイルに書いてから rename する。直接上書きすると、書き込み途中の JSON を
 * sampler が読んだ瞬間に「登録済みのキーが未登録」に見える。
 */
function writeStoredKey(path: string, stored: StoredKey): void {
  const dir = dirname(path);

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  const temp = `${path}.tmp`;

  writeFileSync(temp, JSON.stringify({ version: FILE_VERSION, ...stored }), { mode: 0o600 });
  renameSync(temp, path);
}
