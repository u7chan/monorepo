// 環境変数から待ち受けと保存先を決める既定値を固定する。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GEMINI_CLI_TIMEOUT_MS } from "../src/server/gemini/cli";
import { SERVER_IDLE_TIMEOUT_SECONDS, loadConfig } from "../src/server/config";

describe("loadConfig", () => {
  test("未設定なら既定の待ち受け・保存先・取得間隔になる", () => {
    expect(loadConfig({}, "0.1.0")).toEqual({
      host: "0.0.0.0",
      port: 3000,
      dataDir: "/app/data",
      credentialDir: "/app/credentials",
      pollIntervalMs: 600_000,
      development: true,
      version: "0.1.0",
      trustProxy: false,
      cookieSecure: "auto",
    });
  });

  test("HOST / PORT / DATA_DIR / CREDENTIAL_DIR を反映する", () => {
    const config = loadConfig(
      {
        HOST: "127.0.0.1",
        PORT: "8080",
        DATA_DIR: "./data",
        CREDENTIAL_DIR: "./credentials",
        POLL_INTERVAL_MS: "60000",
        NODE_ENV: "production",
        COMMIT_HASH: "abc123",
      },
      "0.1.0",
    );

    expect(config).toEqual({
      host: "127.0.0.1",
      port: 8080,
      dataDir: "./data",
      credentialDir: "./credentials",
      pollIntervalMs: 60_000,
      development: false,
      version: "abc123",
      trustProxy: false,
      cookieSecure: "auto",
    });
  });

  test("PORT が数値でない / 範囲外なら起動しない", () => {
    for (const port of ["abc", "0", "65536", "1.5", "-1"]) {
      expect(() => loadConfig({ PORT: port }, "0.1.0")).toThrow();
    }
  });

  test("POLL_INTERVAL_MS は 1 分未満・非整数を受け付けない", () => {
    for (const interval of ["0", "1000", "59999", "1.5", "abc"]) {
      expect(() => loadConfig({ POLL_INTERVAL_MS: interval }, "0.1.0")).toThrow();
    }
  });
});

describe("SERVER_IDLE_TIMEOUT_SECONDS", () => {
  test("Gemini のログアウトの最大（進行中の取得 2 回 + 確認 1 回の CLI の期限）より長く、Bun の上限 255 秒以下", () => {
    expect(SERVER_IDLE_TIMEOUT_SECONDS * 1000).toBeGreaterThan(3 * GEMINI_CLI_TIMEOUT_MS);
    expect(SERVER_IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(255);
  });

  test("Bun.serve へ渡している", () => {
    // server.ts は副作用を持つ入口で import できない。既定の 10 秒に戻る変更だけを見張る。
    const source = readFileSync(resolve(import.meta.dir, "../src/server.ts"), "utf8");

    expect(source).toMatch(/idleTimeout: SERVER_IDLE_TIMEOUT_SECONDS,/);
  });
});
