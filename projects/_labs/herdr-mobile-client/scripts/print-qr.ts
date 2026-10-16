// scripts/pair.sh が発行 API の応答を標準入力で渡す。URL を QR として端末に描画し、URL と残り秒数を表示する。
import { readFileSync } from "node:fs"
import { pairQrModules, parsePairPayload, remainingSeconds, renderQr } from "./qr"

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

if (process.stdin.isTTY) {
  fail("使い方: pnpm pair（発行 API の応答を標準入力から受け取ります）")
}

const raw = readFileSync(0, "utf8")

let parsed: unknown

try {
  parsed = JSON.parse(raw)
} catch {
  fail(`応答を JSON として解釈できません: ${raw.trim()}`)
}

const payload = parsePairPayload(parsed)

if (payload === null) {
  fail(`応答に url と expiresAt がありません: ${raw.trim()}`)
}

process.stdout.write(renderQr(pairQrModules(payload.url)))
process.stdout.write(`${payload.url}\n`)

const remaining = remainingSeconds(payload.expiresAt, Date.now())

process.stdout.write(
  remaining === null
    ? `有効期限: ${payload.expiresAt}\n`
    : `有効期限: 残り ${remaining} 秒（${payload.expiresAt}）\n`,
)
