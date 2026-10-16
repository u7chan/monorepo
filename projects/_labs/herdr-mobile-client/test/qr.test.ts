// QR の描画（ハーフブロック・クワイエットゾーン・ANSI のリセット）と残り秒数の計算を固定する。
import assert from "node:assert/strict"
import test from "node:test"
import { QR_QUIET_ZONE_MODULES, pairQrModules, parsePairPayload, remainingSeconds, renderQr } from "../scripts/qr"

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g

function visibleLines(rendered: string): string[] {
  const lines = rendered.replace(ANSI_PATTERN, "").split("\n")

  assert.equal(lines.at(-1), "", "末尾は改行で終わる")

  return lines.slice(0, -1)
}

test("クワイエットゾーンを 4 モジュール付けてハーフブロックで描画する", () => {
  const modules = [
    [true, false, true],
    [false, true, false],
    [true, false, true],
  ]

  const lines = visibleLines(renderQr(modules))
  const width = modules.length + QR_QUIET_ZONE_MODULES * 2

  assert.equal(QR_QUIET_ZONE_MODULES, 4)
  assert.equal(lines.length, Math.ceil(width / 2))
  assert.deepEqual(lines.map((line) => line.length), Array.from({ length: lines.length }, () => width))
  assert.equal(lines[0], " ".repeat(width))
  assert.equal(lines[1], " ".repeat(width))
  assert.equal(lines[2], `${" ".repeat(4)}▀▄▀${" ".repeat(4)}`)
  assert.equal(lines[3], `${" ".repeat(4)}▀ ▀${" ".repeat(4)}`)
  assert.equal(lines[4], " ".repeat(width))
  assert.equal(lines[5], " ".repeat(width))
})

test("描画は白背景と黒のモジュールを ANSI で指定し、末尾でリセットする", () => {
  const rendered = renderQr([
    [true, false],
    [true, false],
  ])

  assert.equal(rendered.startsWith("\x1b[47m\x1b[30m"), true)
  assert.equal(rendered.endsWith("\x1b[0m\n"), true)
  assert.equal(rendered.includes("█"), true)
})

test("URL から QR のモジュール行列を作る", () => {
  const modules = pairQrModules("http://192.0.2.1:18081/#pair=AbCdEfGhIjK")

  assert.equal(modules.length >= 29, true)
  assert.equal(modules.length % 2, 1)
  assert.equal(modules.every((row) => row.length === modules.length), true)
})

test("応答から url と expiresAt だけを取り出す", () => {
  assert.deepEqual(parsePairPayload({ url: "http://192.0.2.1:18081/#pair=AbCdEfGhIjK", expiresAt: "x" }), {
    url: "http://192.0.2.1:18081/#pair=AbCdEfGhIjK",
    expiresAt: "x",
  })
  assert.equal(parsePairPayload({ url: "http://192.0.2.1:18081/", expiresAt: "" }), null)
  assert.equal(parsePairPayload({ url: "", expiresAt: "x" }), null)
  assert.equal(parsePairPayload({ url: 1, expiresAt: "x" }), null)
  assert.equal(parsePairPayload({ url: "u" }), null)
  assert.equal(parsePairPayload(null), null)
  assert.equal(parsePairPayload([]), null)
})

test("残り秒数は切り上げ、期限を過ぎたら 0 にする", () => {
  const expiresAt = "2026-10-15T00:00:00.000Z"

  assert.equal(remainingSeconds(expiresAt, Date.parse("2026-10-14T23:59:00.000Z")), 60)
  assert.equal(remainingSeconds(expiresAt, Date.parse("2026-10-14T23:59:59.500Z")), 1)
  assert.equal(remainingSeconds(expiresAt, Date.parse("2026-10-15T00:00:00.000Z")), 0)
  assert.equal(remainingSeconds(expiresAt, Date.parse("2026-10-15T00:00:01.000Z")), 0)
  assert.equal(remainingSeconds("not-a-date", 0), null)
})
