// 表示の切り替えが保存値と食い違うと、次に開いたときだけ別の表示になる。既定へ倒す境界を固定する。
import { describe, expect, test } from "bun:test";
import { VIEW_MODE_STORAGE_KEY, parseViewMode, readViewMode, writeViewMode } from "../src/client/lib/view-mode";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));

  return {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => void values.set(key, value),
  };
}

const brokenStorage = {
  getItem: (): string | null => {
    throw new Error("storage is blocked");
  },
  setItem: (): void => {
    throw new Error("storage is blocked");
  },
};

describe("parseViewMode", () => {
  test("compact だけを簡易表示として読む", () => {
    expect(parseViewMode("compact")).toBe("compact");
    expect(parseViewMode("standard")).toBe("standard");
  });

  test("未保存と知らない値は標準表示にする", () => {
    expect(parseViewMode(null)).toBe("standard");
    expect(parseViewMode("")).toBe("standard");
    expect(parseViewMode("COMPACT")).toBe("standard");
    expect(parseViewMode("simple")).toBe("standard");
  });
});

describe("readViewMode / writeViewMode", () => {
  test("保存した表示を読み戻す", () => {
    const storage = memoryStorage();

    writeViewMode(storage, "compact");
    expect(storage.getItem(VIEW_MODE_STORAGE_KEY)).toBe("compact");
    expect(readViewMode(storage)).toBe("compact");

    writeViewMode(storage, "standard");
    expect(readViewMode(storage)).toBe("standard");
  });

  test("保存が無い、または読めないときは標準表示で開く", () => {
    expect(readViewMode(null)).toBe("standard");
    expect(readViewMode(memoryStorage())).toBe("standard");
    expect(readViewMode(brokenStorage)).toBe("standard");
  });

  test("書き込めない環境でも例外を投げない", () => {
    expect(() => writeViewMode(null, "compact")).not.toThrow();
    expect(() => writeViewMode(brokenStorage, "compact")).not.toThrow();
  });
});
