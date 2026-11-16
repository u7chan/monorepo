import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/server/config";

describe("loadConfig", () => {
  test("未設定なら 0.0.0.0:3100 で待ち受ける", () => {
    expect(loadConfig({})).toMatchObject({ host: "0.0.0.0", port: 3100 });
  });

  test("HOST / PORT を読み、空白だけの値は既定へ倒す", () => {
    expect(loadConfig({ HOST: "127.0.0.1", PORT: "8080" })).toMatchObject({ host: "127.0.0.1", port: 8080 });
    expect(loadConfig({ HOST: "  ", PORT: "  " })).toMatchObject({ host: "0.0.0.0", port: 3100 });
  });

  test("NODE_ENV=production 以外は開発として扱う", () => {
    expect(loadConfig({ NODE_ENV: "production" }).development).toBe(false);
    expect(loadConfig({}).development).toBe(true);
  });

  test("PORT が整数でない・範囲外なら起動しない", () => {
    for (const value of ["0", "70000", "-1", "1.5", "abc"]) {
      expect(() => loadConfig({ PORT: value })).toThrow("PORT が不正です");
    }
  });
});
