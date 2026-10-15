// scripts/lan-access.sh が、追加した規則の RemoteAddress を期待する LAN セグメントと比較するために呼ぶ。
// 一致すれば 0、一致しなければ 1 で終了する。
import { cidrMatchesAny, normalizedCidr } from "./cidr"

const expected = process.argv[2]
const actual = process.argv[3]

if (expected === undefined || actual === undefined) {
  process.stderr.write(
    "使い方: node --import tsx scripts/cidr-cli.ts <期待する CIDR> <読み戻した RemoteAddress（カンマ区切り）>\n",
  )
  process.exit(2)
}

const candidates = actual
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value !== "")

const matched = cidrMatchesAny(expected, candidates)
const normalizedExpected = normalizedCidr(expected) ?? expected
const normalizedCandidates = candidates.map((value) => normalizedCidr(value) ?? value)

process.stdout.write(
  `検証: remoteaddress ${matched ? "一致" : "不一致"}（読み戻し ${candidates.join(", ")} → ${normalizedCandidates.join(", ")} / 期待 ${expected} → ${normalizedExpected}）\n`,
)

process.exit(matched ? 0 : 1)
