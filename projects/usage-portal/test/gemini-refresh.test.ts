// Gemini の取得契機（15 分の自動制限・60 秒の間隔・single-flight）と、失敗の残し方を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiCliError, type GeminiCli, type GeminiCliResult } from "../src/server/gemini/cli";
import { GEMINI_MANUAL_COOLDOWN_MS, createGeminiUsageService } from "../src/server/gemini/service";
import { loadProviderUsage, openDatabase, saveProviderSnapshot, type DatabaseHandle } from "../src/server/db";
import { parseGeminiUsage } from "../src/server/providers/gemini";
import { BASE_TIME } from "./support";

const CREDENTIAL_DIR = join(tmpdir(), "usage-portal-gemini-test-credentials");
const MINUTE = 60 * 1000;
const SIGN_IN_STDERR = "Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n";
const USAGE_BODY = {
  command: {
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.6, reset_time: "2026-12-05T07:57:12Z" },
            { id: "gemini-5h", window: "5h", remaining_fraction: 0.25, reset_time: "2026-11-28T12:57:12Z" },
          ],
        },
      ],
    },
  },
};

const dirs: string[] = [];
const handles: DatabaseHandle[] = [];

function open(): DatabaseHandle {
  const dir = mkdtempSync(join(tmpdir(), "usage-portal-gemini-refresh-"));
  const handle = openDatabase(dir);

  dirs.push(dir);
  handles.push(handle);

  return handle;
}

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.close();
  }

  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type Respond = (args: readonly string[]) => GeminiCliResult | Error | Promise<GeminiCliResult>;

function harness(options: { models?: GeminiCliResult | Error; usage?: unknown; respond?: Respond } = {}) {
  let clock = BASE_TIME;
  const db = open();
  const calls: string[][] = [];
  const logs: string[] = [];
  const models = options.models ?? { exitCode: 0, stdout: "gemini-4-neon-high\tx\n", stderr: "" };
  const cli: GeminiCli = {
    run: async (args) => {
      calls.push([...args]);

      const result =
        options.respond?.(args) ??
        (args[0] === "models"
          ? models
          : { exitCode: 0, stdout: JSON.stringify(options.usage ?? USAGE_BODY), stderr: "" });
      const resolved = await result;

      if (resolved instanceof Error) {
        throw resolved;
      }

      return resolved;
    },
  };
  const service = createGeminiUsageService({
    db,
    cli,
    credentialDir: CREDENTIAL_DIR,
    now: () => clock,
    log: (message) => logs.push(message),
  });

  return {
    service,
    db,
    cli,
    calls,
    logs,
    advance(ms: number) {
      clock += ms;
    },
    modelsCalls: () => calls.filter((args) => args[0] === "models").length,
    usageCalls: () => calls.filter((args) => args[0] === "-p").length,
  };
}

function geminiSnapshot(capturedAt: number) {
  return parseGeminiUsage(USAGE_BODY, capturedAt);
}

describe("createGeminiUsageService", () => {
  test("前回の取得が無ければ自動でも CLI を起動して保存する", async () => {
    const h = harness();

    await expect(h.service.refresh("auto")).resolves.toEqual({ state: "refreshed" });
    expect(h.calls).toHaveLength(2);
    expect(loadProviderUsage(h.db, ["gemini"]).get("gemini")?.snapshot?.windows).toHaveLength(2);
    // sample も既存のテーブルへ source id gemini で追記する。
    expect(
      h.db.db.query("SELECT window_id FROM usage_sample WHERE provider = 'gemini' ORDER BY window_id").all(),
    ).toEqual([{ window_id: "rolling" }, { window_id: "weekly" }]);
  });

  test("自動は前回取得から 15 分以内なら起動しない", async () => {
    const h = harness();

    saveProviderSnapshot(h.db, "gemini", geminiSnapshot(BASE_TIME - 15 * MINUTE));

    await expect(h.service.refresh("auto")).resolves.toEqual({ state: "skipped", reason: "fresh" });
    expect(h.calls).toHaveLength(0);
  });

  test("15 分を過ぎた自動は取り直す", async () => {
    const h = harness();

    saveProviderSnapshot(h.db, "gemini", geminiSnapshot(BASE_TIME - 15 * MINUTE - 1));

    await expect(h.service.refresh("auto")).resolves.toEqual({ state: "refreshed" });
    expect(h.modelsCalls()).toBe(1);
    expect(h.usageCalls()).toBe(1);
  });

  test("手動は 15 分の制限を受けない", async () => {
    const h = harness();

    saveProviderSnapshot(h.db, "gemini", geminiSnapshot(BASE_TIME));

    await expect(h.service.refresh("manual")).resolves.toEqual({ state: "refreshed" });
    expect(h.modelsCalls()).toBe(1);
  });

  test("手動は前回の試行から 60 秒空ける", async () => {
    const h = harness();

    await expect(h.service.refresh("manual")).resolves.toEqual({ state: "refreshed" });
    await expect(h.service.refresh("manual")).resolves.toEqual({ state: "skipped", reason: "cooldown" });
    expect(h.modelsCalls()).toBe(1);

    h.advance(GEMINI_MANUAL_COOLDOWN_MS);

    await expect(h.service.refresh("manual")).resolves.toEqual({ state: "refreshed" });
    expect(h.modelsCalls()).toBe(2);
  });

  test("失敗直後の自動は 15 分たつまで CLI を起動せず、15 分後に 1 回だけ再試行する", async () => {
    const h = harness({ models: { exitCode: 1, stdout: "", stderr: SIGN_IN_STDERR } });

    // 20 分前の成功値は古いので、最初の auto は 1 回だけ試して失敗する。
    saveProviderSnapshot(h.db, "gemini", geminiSnapshot(BASE_TIME - 20 * MINUTE));

    await expect(h.service.refresh("auto")).resolves.toEqual({ state: "failed", error: "not_connected" });
    expect(h.modelsCalls()).toBe(1);

    // 失敗の時刻から 15 分たつまでは、タブに戻るたびの auto でも起動しない。
    for (const minutes of [2, 2, 2]) {
      h.advance(minutes * MINUTE);

      await expect(h.service.refresh("auto")).resolves.toEqual({ state: "skipped", reason: "fresh" });
    }

    expect(h.modelsCalls()).toBe(1);

    // 15 分を過ぎたら 1 回だけ再試行し、その直後はまた 15 分待つ。
    h.advance(9 * MINUTE + 1);

    await expect(h.service.refresh("auto")).resolves.toEqual({ state: "failed", error: "not_connected" });
    expect(h.modelsCalls()).toBe(2);
    await expect(h.service.refresh("auto")).resolves.toEqual({ state: "skipped", reason: "fresh" });
    expect(h.modelsCalls()).toBe(2);
  });

  test("再起動しても、失敗直後の自動は 15 分たつまで CLI を起動しない", async () => {
    const h = harness({ models: { exitCode: 1, stdout: "", stderr: SIGN_IN_STDERR } });

    saveProviderSnapshot(h.db, "gemini", geminiSnapshot(BASE_TIME - 20 * MINUTE));

    await expect(h.service.refresh("auto")).resolves.toEqual({ state: "failed", error: "not_connected" });
    expect(h.modelsCalls()).toBe(1);

    // 同じ DB を使う新しい service。失敗の時刻は provider_error に残っている。
    const restarted = createGeminiUsageService({
      db: h.db,
      cli: h.cli,
      credentialDir: CREDENTIAL_DIR,
      now: () => BASE_TIME + MINUTE,
      log: () => {},
    });

    await expect(restarted.refresh("auto")).resolves.toEqual({ state: "skipped", reason: "fresh" });
    expect(h.modelsCalls()).toBe(1);
  });

  test("未接続は /usage を起動せず、not_connected を保存する", async () => {
    const h = harness({ models: { exitCode: 1, stdout: "", stderr: SIGN_IN_STDERR } });

    await expect(h.service.refresh("auto")).resolves.toEqual({ state: "failed", error: "not_connected" });
    expect(h.usageCalls()).toBe(0);
    expect(loadProviderUsage(h.db, ["gemini"]).get("gemini")?.error?.code).toBe("not_connected");
  });

  test("失敗は error だけを書き、前回の snapshot を残す", async () => {
    const h = harness({ models: new GeminiCliError("timeout", "timeout") });

    saveProviderSnapshot(h.db, "gemini", geminiSnapshot(BASE_TIME - 20 * MINUTE));

    await expect(h.service.refresh("auto")).resolves.toEqual({ state: "failed", error: "upstream" });

    const stored = loadProviderUsage(h.db, ["gemini"]).get("gemini");

    expect(stored?.snapshot?.capturedAt).toBe(BASE_TIME - 20 * MINUTE);
    expect(stored?.error?.code).toBe("upstream");
  });

  test("同時の要求は single-flight で 1 回にまとめる", async () => {
    const h = harness();
    const [first, second] = await Promise.all([h.service.refresh("manual"), h.service.refresh("manual")]);

    expect(first).toEqual({ state: "refreshed" });
    expect(second).toEqual({ state: "refreshed" });
    expect(h.modelsCalls()).toBe(1);
    expect(h.calls).toHaveLength(2);
  });

  test("CLI の出力本文・stderr・上流の自由文は DB にもログにも残さない", async () => {
    const h = harness({
      models: { exitCode: 1, stdout: "stdout-SENTINEL", stderr: "stderr-SENTINEL" },
    });

    await h.service.refresh("manual");
    h.advance(GEMINI_MANUAL_COOLDOWN_MS);

    const usage = harness({
      usage: {
        command: {
          data: {
            groups: [
              {
                name: "name-SENTINEL",
                buckets: [
                  {
                    id: "gemini-5h",
                    window: "5h",
                    remaining_fraction: 0.5,
                    name: "bucket-SENTINEL",
                    description: "d-SENTINEL",
                  },
                ],
              },
            ],
          },
        },
      },
    });

    await usage.service.refresh("manual");

    for (const target of [h, usage]) {
      expect(target.logs.join("\n")).not.toContain("SENTINEL");

      for (const table of ["provider_snapshot", "provider_error", "usage_sample"]) {
        expect(JSON.stringify(target.db.db.query(`SELECT * FROM ${table}`).all())).not.toContain("SENTINEL");
      }
    }
  });
});
