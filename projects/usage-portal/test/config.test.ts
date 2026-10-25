// 環境変数から待ち受けと保存先を決める既定値を固定する。
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/server/config";

describe("loadConfig", () => {
  test("未設定なら 0.0.0.0:3000、/app/data、development になる", () => {
    expect(loadConfig({}, "0.1.0")).toEqual({
      host: "0.0.0.0",
      port: 3000,
      dataDir: "/app/data",
      development: true,
      version: "0.1.0",
    });
  });

  test("HOST / PORT / DATA_DIR を反映し、production では development を切る", () => {
    const config = loadConfig(
      {
        HOST: "127.0.0.1",
        PORT: "8080",
        DATA_DIR: "./data",
        NODE_ENV: "production",
        COMMIT_HASH: "abc123",
      },
      "0.1.0",
    );

    expect(config).toEqual({
      host: "127.0.0.1",
      port: 8080,
      dataDir: "./data",
      development: false,
      version: "abc123",
    });
  });

  test("PORT が数値でない / 範囲外なら起動しない", () => {
    for (const port of ["abc", "0", "65536", "1.5", "-1"]) {
      expect(() => loadConfig({ PORT: port }, "0.1.0")).toThrow();
    }
  });
});
