const PIN_PATTERN = /^\d{6}$/;

export function isValidPin(value: unknown): value is string {
  return typeof value === "string" && PIN_PATTERN.test(value);
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
