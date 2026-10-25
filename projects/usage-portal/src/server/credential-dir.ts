import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CODEX_AUTH_FILE, CODEX_DEVICE_ID_FILE } from "./codex/auth";
import { OPENCODE_KEY_FILE } from "./opencode/auth";

/** `CREDENTIAL_DIR` に置く秘密の一覧。増やしたら起動時の権限検査にも足す。 */
export const CREDENTIAL_FILES = [CODEX_AUTH_FILE, CODEX_DEVICE_ID_FILE, OPENCODE_KEY_FILE] as const;

/**
 * 資格情報のディレクトリを 0700、既存のファイルを 0600 に揃える。
 * 0600 にできない状態で動かすと秘密が他ユーザーから読めるため、呼び出し側は失敗で起動を止める。
 */
export function prepareCredentialDir(credentialDir: string): void {
  mkdirSync(credentialDir, { recursive: true, mode: 0o700 });
  chmodSync(credentialDir, 0o700);

  for (const file of CREDENTIAL_FILES) {
    const path = join(credentialDir, file);

    if (existsSync(path)) {
      chmodSync(path, 0o600);
    }
  }
}
