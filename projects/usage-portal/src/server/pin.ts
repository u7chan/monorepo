const PIN_PATTERN = /^\d{6}$/;

/** Argon2id の PHC 文字列。salt と hash は base64（padding あり/なし）。 */
const ARGON2ID_PATTERN =
  /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,4}),p=(\d{1,2})\$([A-Za-z0-9+/]{16,}={0,2})\$([A-Za-z0-9+/]{16,}={0,2})$/;

/** 弱いパラメータへ書き換えられたハッシュを受け入れない下限。Bun の既定は m=65536。 */
const MIN_MEMORY_KIB = 8192;
const MAX_PARALLELISM = 16;

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

  return (
    Number.isSafeInteger(memory) &&
    memory >= MIN_MEMORY_KIB &&
    Number.isSafeInteger(iterations) &&
    iterations >= 1 &&
    Number.isSafeInteger(parallelism) &&
    parallelism >= 1 &&
    parallelism <= MAX_PARALLELISM
  );
}

export async function hashPin(pin: string): Promise<string> {
  return Bun.password.hash(pin, { algorithm: "argon2id" });
}

export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(pin, hash);
  } catch {
    return false;
  }
}
