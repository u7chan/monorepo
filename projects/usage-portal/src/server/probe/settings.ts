import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const PROBE_SETTINGS_FILE = "settings.json";

/** 送信に使うモデルと思考レベル。既定値は置かず、画面から選ばれた値だけを保存する。 */
export type CodexProbeConfig = { model: string; thinking: ModelThinkingLevel };

export type ProbeSettings = { codex: CodexProbeConfig | null };

export type ProbeSettingsStore = {
  /** 読めないファイルは「未設定」として返す。環境変数や既定値へは落とさない。 */
  read: () => ProbeSettings;
  writeCodex: (config: CodexProbeConfig | null) => void;
};

export const UNSET_PROBE_SETTINGS: ProbeSettings = { codex: null };

/**
 * 秘密ではないので `CREDENTIAL_DIR` ではなく `DATA_DIR` に置く。
 * 消えても機能が黙って無効になるだけなので、欠損はエラーにしない。
 */
export function createProbeSettings(options: { dataDir: string; log?: (message: string) => void }): ProbeSettingsStore {
  const path = join(options.dataDir, PROBE_SETTINGS_FILE);
  const log = options.log ?? ((message: string) => console.warn(`[usage-portal] ${message}`));
  // 壊れたファイルは読むたびに未設定へ戻る。画面の再取得ごとに同じ警告を出さない。
  let warnedInvalidFile = false;

  return {
    read() {
      const settings = readSettings(path);

      if (settings === null) {
        if (!warnedInvalidFile && existsSync(path)) {
          warnedInvalidFile = true;
          log("settings.json を読めないため、送信の設定を未設定として扱います");
        }

        return UNSET_PROBE_SETTINGS;
      }

      warnedInvalidFile = false;

      return settings;
    },
    writeCodex(config) {
      writeSettings(path, { codex: config });
      warnedInvalidFile = false;
    },
  };
}

/** 壊れた JSON・知らない形は `null`（未設定）。内容はログにも出さない。 */
function readSettings(path: string): ProbeSettings | null {
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

    const probe = (parsed as Record<string, unknown>).probe;

    if (typeof probe !== "object" || probe === null) {
      return null;
    }

    const codex = (probe as Record<string, unknown>).codex;

    if (codex === null || codex === undefined) {
      return UNSET_PROBE_SETTINGS;
    }

    const config = readConfig(codex);

    // 設定が壊れている状態を「未設定」に倒すと、利用者が解除したのか壊れたのか区別できない。
    // どちらも送信できない点は同じなので、警告を 1 回出して未設定として扱う。
    return config === null ? null : { codex: config };
  } catch {
    return null;
  }
}

function readConfig(value: unknown): CodexProbeConfig | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const { model, thinking } = value as Record<string, unknown>;

  if (typeof model !== "string" || model === "" || typeof thinking !== "string" || thinking === "") {
    return null;
  }

  return { model, thinking: thinking as ModelThinkingLevel };
}

/** 一時ファイルに書いてから rename する。書き込み途中の JSON を読ませない。 */
function writeSettings(path: string, settings: ProbeSettings): void {
  const dir = dirname(path);

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  const temp = `${path}.tmp`;

  writeFileSync(temp, JSON.stringify({ probe: settings }), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}
