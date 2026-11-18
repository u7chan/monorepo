// Claude の取得契機（15 分の自動制限・60 秒の間隔・single-flight）と、失敗の残し方を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_MANUAL_COOLDOWN_MS, createClaudeUsageService } from "../src/server/claude/service";
import type { ClaudeCli } from "../src/server/claude/cli";
import { loadProviderUsage, openDatabase, saveProviderSnapshot, type DatabaseHandle } from "../src/server/db";
import { parseClaudeUsage } from "../src/server/providers/claude";
import { BASE_TIME } from "./support";

const MINUTE = 60 * 1000;
const USAGE_TEXT = [
  "Current session: 12% used · resets Nov 19, 12:50am (America/Los_Angeles)",
  "Current week (all models): 45% used · resets Nov 25, 6am (America/Los_Angeles)",
].join("\n");
const AUTH_OK = { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" };

const dirs: string[] = [];
const handles: DatabaseHandle[] = [];

function open(): DatabaseHandle {
  const dir = mkdtempSync(join(tmpdir(), "usage-portal-claude-refresh-"));
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

function harness(options: { auth?: unknown; usage?: string } = {}) {
  let clock = BASE_TIME;
  const db = open();
  const calls: string[][] = [];
  const logs: string[] = [];
  const cli: ClaudeCli = {
    run: async (args) => {
      calls.push([...args]);

      if (args[0] === "auth") {
        return JSON.stringify(options.auth ?? AUTH_OK);
      }

      return JSON.stringify({ result: options.usage ?? USAGE_TEXT });
    },
  };
  const service = createClaudeUsageService({
    db,
    cli,
    now: () => clock,
    log: (message) => logs.push(message),
  });

  return {
    service,
    db,
    calls,
    logs,
    advance(ms: number) {
      clock += ms;
    },
    authCalls: () => calls.filter((args) => args[0] === "auth").length,
  };
}

function claudeSnapshot(capturedAt: number) {
  return parseClaudeUsage(USAGE_TEXT, { capturedAt, plan: "Max" });
}

describe("createClaudeUsageService", () => {
  test("前回の取得が無ければ自動でも CLI を起動して保存する", async () => {
    const h = harness();

    await expect(h.service.refresh("auto")).resolves.toEqual({ state: "refreshed" });
    expect(h.calls).toHaveLength(2);
    expect(loadProviderUsage(h.db, ["claude"]).get("claude")?.snapshot?.windows).toHaveLength(2);
  });

  test("自動は前回取得から 15 分以内なら起動しない", async () => {
    const h = harness();

    saveProviderSnapshot(h.db, "claude", claudeSnapshot(BASE_TIME - 15 * MINUTE));

    await expect(h.service.refresh("auto")).resolves.toEqual({ state: "skipped", reason: "fresh" });
    expect(h.calls).toHaveLength(0);
  });

  test("15 分を過ぎた自動は取り直す", async () => {
    const h = harness();

    saveProviderSnapshot(h.db, "claude", claudeSnapshot(BASE_TIME - 15 * MINUTE - 1));

    await expect(h.service.refresh("auto")).resolves.toEqual({ state: "refreshed" });
    expect(h.authCalls()).toBe(1);
  });

  test("手動は 15 分の制限を受けない", async () => {
    const h = harness();

    saveProviderSnapshot(h.db, "claude", claudeSnapshot(BASE_TIME));

    await expect(h.service.refresh("manual")).resolves.toEqual({ state: "refreshed" });
    expect(h.authCalls()).toBe(1);
  });

  test("手動は前回の試行から 60 秒空ける", async () => {
    const h = harness();

    await expect(h.service.refresh("manual")).resolves.toEqual({ state: "refreshed" });
    await expect(h.service.refresh("manual")).resolves.toEqual({ state: "skipped", reason: "cooldown" });
    expect(h.authCalls()).toBe(1);

    h.advance(CLAUDE_MANUAL_COOLDOWN_MS);

    await expect(h.service.refresh("manual")).resolves.toEqual({ state: "refreshed" });
    expect(h.authCalls()).toBe(2);
  });

  test("失敗した直後の自動も 60 秒は空ける", async () => {
    const h = harness({ auth: { loggedIn: false, authMethod: "none" } });

    await expect(h.service.refresh("auto")).resolves.toEqual({ state: "failed", error: "not_connected" });
    await expect(h.service.refresh("auto")).resolves.toEqual({ state: "skipped", reason: "cooldown" });
    expect(h.authCalls()).toBe(1);
  });

  test("未接続は /usage を起動せず、error を保存する", async () => {
    const h = harness({ auth: { loggedIn: true, authMethod: "api_key" } });

    await expect(h.service.refresh("auto")).resolves.toEqual({ state: "failed", error: "subscription_required" });
    expect(h.calls).toHaveLength(1);
    expect(loadProviderUsage(h.db, ["claude"]).get("claude")?.error?.code).toBe("subscription_required");
  });

  test("同時の要求は single-flight で 1 回にまとめる", async () => {
    const h = harness();
    const [first, second] = await Promise.all([h.service.refresh("manual"), h.service.refresh("manual")]);

    expect(first).toEqual({ state: "refreshed" });
    expect(second).toEqual({ state: "refreshed" });
    expect(h.authCalls()).toBe(1);
    expect(h.calls).toHaveLength(2);
  });

  test("CLI の出力本文は DB にもログにも残さない", async () => {
    const h = harness({ usage: `${USAGE_TEXT}\nSENTINEL-CLI-OUTPUT` });

    await h.service.refresh("manual");

    expect(h.logs.join("\n")).not.toContain("SENTINEL");

    for (const table of ["provider_snapshot", "provider_error", "usage_sample"]) {
      expect(JSON.stringify(h.db.db.query(`SELECT * FROM ${table}`).all())).not.toContain("SENTINEL");
    }
  });
});
