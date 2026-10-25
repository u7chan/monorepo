// PIN の形式と、Argon2id によるハッシュ・照合の契約を固定する。
import { describe, expect, test } from "bun:test";
import { hashPin, isArgon2idHash, isValidPin, verifyPin } from "../src/server/pin";

describe("isValidPin", () => {
  test("6 桁の数字だけを受け付ける", () => {
    expect(isValidPin("123456")).toBe(true);

    for (const value of ["12345", "1234567", "12345a", " 123456", "", null, 123456]) {
      expect(isValidPin(value)).toBe(false);
    }
  });
});

describe("isArgon2idHash", () => {
  test("生成したハッシュを受け付け、壊れた / 弱いパラメータのハッシュを拒否する", async () => {
    const hash = await hashPin("123456");

    expect(isArgon2idHash(hash)).toBe(true);

    for (const value of [
      "",
      "$argon2id$",
      "$argon2id$broken",
      "$argon2i$v=19$m=65536,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaA",
      // m を弱めたハッシュ (レインボーテーブル対策の下限を下回る)
      "$argon2id$v=19$m=1024,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaA",
      // hash 部分が短すぎる切り詰め
      hash.slice(0, -30),
      // 1〜2 文字の切り詰めは最小長を満たしたまま base64 として壊れる
      hash.slice(0, -1),
      hash.slice(0, -2),
      `${hash}=`,
    ]) {
      expect(isArgon2idHash(value)).toBe(false);
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
