import { describe, expect, it } from "vitest";
import { greet } from "./greet.js";

describe("greet", () => {
  it("greets a name", () => {
    expect(greet("World")).toBe("Hello, World!");
  });

  it("handles an empty name", () => {
    expect(greet("")).toBe("Hello, !");
  });

  it("preserves spaces in a name", () => {
    expect(greet("pnpm sample")).toBe("Hello, pnpm sample!");
  });

  it("supports Unicode names", () => {
    expect(greet("サンプル")).toBe("Hello, サンプル!");
  });
});
