// PIN の形式と、Argon2id によるハッシュ・照合の契約を固定する。
import { describe, expect, test } from "bun:test";
import { hashPin, isValidPin, verifyPin } from "../src/server/pin";

describe("isValidPin", () => {
  test("6 桁の数字だけを受け付ける", () => {
    expect(isValidPin("123456")).toBe(true);

    for (const value of ["12345", "1234567", "12345a", " 123456", "", null, 123456]) {
      expect(isValidPin(value)).toBe(false);
    }
  });
});

describe("hashPin / verifyPin", () => {
  test("Argon2id のハッシュを返し、同じ PIN だけ通す", async () => {
    const hash = await hashPin("123456");

    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).not.toContain("123456");
    expect(await verifyPin("123456", hash)).toBe(true);
    expect(await verifyPin("654321", hash)).toBe(false);
  });

  test("壊れたハッシュでは例外を投げず false を返す", async () => {
    for (const hash of ["", "$argon2id$broken", "not-a-hash"]) {
      expect(await verifyPin("123456", hash)).toBe(false);
    }
  });
});
