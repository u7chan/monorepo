import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_PREFIX = "ur_";
const SECRET_BYTES = 32;
const TOKEN_PATTERN = /^ur_[A-Za-z0-9_-]{43}$/;
/** 一覧に出す先頭。`ur_` + 8 文字で、秘密の後半とは切り離せる長さにする。 */
const DISPLAY_LENGTH = 11;

/** 32 bytes を base64url で 43 文字にする。推測できない値なので、保存は SHA-256 で足りる。 */
export function createToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokenPrefix(token: string): string {
  return token.slice(0, DISPLAY_LENGTH);
}

export function isTokenFormat(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/** `Authorization: Bearer <token>`。形式が違う値は照合へ回さず null にする。 */
export function readBearer(header: string | undefined): string | null {
  const match = /^Bearer (.+)$/.exec(header ?? "");
  const token = match?.[1]?.trim() ?? "";

  return isTokenFormat(token) ? token : null;
}

/** DB から引いたハッシュとの照合。索引で探した後も、比較の時間差を残さない。 */
export function matchesHash(token: string, storedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(storedHash, "hex");

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
