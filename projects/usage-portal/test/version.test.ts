// COMMIT_HASH が User-Agent の version に反映されることを固定する。
import { describe, expect, test } from "bun:test";
import { readPackageVersion, resolveVersion, userAgentFor } from "../src/server/version";

describe("resolveVersion", () => {
  test("COMMIT_HASH があればそれを version にする", () => {
    expect(resolveVersion("0123456789abcdef0123456789abcdef01234567", "0.1.0")).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
  });

  test("COMMIT_HASH が無い / 空なら package.json の version を使う", () => {
    expect(resolveVersion(undefined, "0.1.0")).toBe("0.1.0");
    expect(resolveVersion("", "0.1.0")).toBe("0.1.0");
    expect(resolveVersion("  ", "0.1.0")).toBe("0.1.0");
  });
});

describe("userAgentFor", () => {
  test("usage-portal/<version> を組み立て、COMMIT_HASH を含める", () => {
    expect(userAgentFor(resolveVersion("0123456789abcdef", "0.1.0"))).toBe("usage-portal/0123456789abcdef");
    expect(userAgentFor(resolveVersion(undefined, "0.1.0"))).toBe("usage-portal/0.1.0");
  });
});

describe("readPackageVersion", () => {
  test("package.json の version を返す", () => {
    expect(readPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
