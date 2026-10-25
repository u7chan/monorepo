const PIN_PATTERN = /^\d{6}$/;

/** Argon2id の PHC 文字列。salt と hash は padding なしの base64（Bun の出力形式）。 */
const ARGON2ID_PATTERN = /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,4}),p=(\d{1,2})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+$/;

/** 弱いパラメータへ書き換えられたハッシュを受け入れない下限。Bun の既定は m=65536。 */
const MIN_MEMORY_KIB = 8192;
const MAX_PARALLELISM = 16;
/**
 * `Bun.password.hash` が書く長さに固定する。Bun は 31 bytes のタグも「別の正しいハッシュ」として
 * 受理するため、範囲で許すと 1 文字の切り詰めを破損として検出できない。
 */
const SALT_BYTES = 32;
const TAG_BYTES = 32;

export function isValidPin(value: unknown): value is string {
  return typeof value === "string" && PIN_PATTERN.test(value);
}

/**
 * 保存されたハッシュが壊れていないかを、照合の前に判定する。
 * prefix だけ見ると `$argon2id$broken` でも「設定済み」になり、正しい PIN でも失敗し続ける。
 */
export function isArgon2idHash(value: string): boolean {
  const match = ARGON2ID_PATTERN.exec(value.trim());

  if (!match) {
    return false;
  }

  const memory = Number(match[1]);
  const iterations = Number(match[2]);
  const parallelism = Number(match[3]);
  const saltBytes = decodeBase64Bytes(match[4] ?? "");
  const tagBytes = decodeBase64Bytes(match[5] ?? "");

  return (
    Number.isSafeInteger(memory) &&
    memory >= MIN_MEMORY_KIB &&
    Number.isSafeInteger(iterations) &&
    iterations >= 1 &&
    Number.isSafeInteger(parallelism) &&
    parallelism >= 1 &&
    parallelism <= MAX_PARALLELISM &&
    saltBytes === SALT_BYTES &&
    tagBytes === TAG_BYTES
  );
}

/**
 * Bun が `InvalidEncoding` で拒否する base64 をここで落とす。
 * 1 文字削るだけの切り詰めは最小長を満たしたまま壊れるため、長さと端数ビットまで見る。
 */
function decodeBase64Bytes(segment: string): number | null {
  if (!BASE64_PATTERN.test(segment) || segment.length % 4 === 1) {
    return null;
  }

  const decoded = Buffer.from(segment, "base64");

  return decoded.toString("base64").replace(/=+$/, "") === segment ? decoded.length : null;
}

export async function hashPin(pin: string): Promise<string> {
  const hash = await Bun.password.hash(pin, { algorithm: "argon2id" });

  // Bun の既定が変わったら、書いた直後に気付けるようにする。読み出し側で初めて壊れるのを避ける。
  if (!isArgon2idHash(hash)) {
    throw new Error("生成した PIN ハッシュが保存形式を満たしません");
  }

  return hash;
}

export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(pin, hash);
  } catch {
    return false;
  }
}
