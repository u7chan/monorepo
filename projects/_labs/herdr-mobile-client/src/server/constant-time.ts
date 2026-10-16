import { createHash, timingSafeEqual } from "node:crypto"

// 長さの違う Buffer を timingSafeEqual へ渡すと例外になるため、固定長のハッシュへ揃えてから比較する。
// 長さの差を比較の分岐に出さないための選択でもある。
export function constantTimeEquals(presented: string, expected: string): boolean {
  const presentedDigest = createHash("sha256").update(presented, "utf8").digest()
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest()

  return timingSafeEqual(presentedDigest, expectedDigest)
}
