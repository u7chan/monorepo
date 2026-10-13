import { randomUUID } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { dirname } from "node:path"

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Sign in with ChatGPT はインストール単位の安定した `ext_agent_host_id`（UUID）を要求する。
 * 再インストール扱いにならないようファイルへ永続化する（ファイル 0600 / ディレクトリ 0700）。
 */
export function readOrCreateDeviceId(
  path: string,
  onWarning?: (message: string) => void,
): string {
  if (existsSync(path)) {
    const value = readFileSync(path, "utf-8").trim()
    if (UUID_PATTERN.test(value)) {
      return value
    }
    onWarning?.(`device id が UUID ではないため作り直します: ${path}`)
  }

  const value = randomUUID()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${value}\n`, { encoding: "utf-8", mode: 0o600 })
  chmodSync(path, 0o600)
  return value
}
