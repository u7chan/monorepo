// Claude のログアウトで、資格情報の破棄・保存の取り消し・cooldown の作り直しを固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_MANUAL_COOLDOWN_MS, createClaudeUsageService } from "../src/server/claude/service";
import { ClaudeCliError, type ClaudeCli } from "../src/server/claude/cli";
import {
  loadProviderUsage,
  openDatabase,
  saveProviderError,
  saveProviderSnapshot,
  type DatabaseHandle,
} from "../src/server/db";
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
  const dir = mkdtempSync(join(tmpdir(), "usage-portal-claude-logout-"));
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

type Run = (args: readonly string[], calls: string[][]) => Promise<string>;

function harness(run: Run = defaultRun) {
  let clock = BASE_TIME;
  const db = open();
  const calls: string[][] = [];
  const logs: string[] = [];
  const cli: ClaudeCli = {
    run: async (args) => {
      calls.push([...args]);

      return await run(args, calls);
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
    statusCalls: () => calls.filter((args) => args[0] === "auth" && args[1] === "status").length,
    logoutCalls: () => calls.filter((args) => args[0] === "auth" && args[1] === "logout").length,
  };
}

async function defaultRun(args: readonly string[]): Promise<string> {
  if (args[0] === "auth" && args[1] === "logout") {
    return "";
  }

  return args[0] === "auth" ? JSON.stringify(AUTH_OK) : JSON.stringify({ result: USAGE_TEXT });
}

function claudeSnapshot(capturedAt: number) {
  return parseClaudeUsage(USAGE_TEXT, { capturedAt, plan: "Max" });
}

function rows(db: DatabaseHandle, table: string): unknown[] {
  return db.db.query(`SELECT * FROM ${table} WHERE provider = 'claude'`).all();
}

describe("ClaudeUsageService.logout", () => {
  test("成功で snapshot と error を消し、sample は残す", async () => {
    const h = harness();

    saveProviderSnapshot(h.db, "claude", claudeSnapshot(BASE_TIME - 5 * MINUTE));
    saveProviderError(h.db, "claude", { code: "upstream", message: "取得できませんでした", at: BASE_TIME - MINUTE });

    const samples = h.db.db.query("SELECT * FROM usage_sample WHERE provider = 'claude'").all();

    expect(await h.service.logout()).toBe(true);
    expect(h.logoutCalls()).toBe(1);
    expect(rows(h.db, "provider_snapshot")).toEqual([]);
    expect(rows(h.db, "provider_error")).toEqual([]);
    expect(h.db.db.query("SELECT * FROM usage_sample WHERE provider = 'claude'").all()).toHaveLength(samples.length);
  });

  test("進行中の取得は、ログアウトの CLI が先に終わっても snapshot を書き戻さない", async () => {
    const gate = deferred<string>();
    const h = harness(async (args) => {
      if (args[0] === "auth" && args[1] === "logout") {
        return "";
      }

      return args[0] === "auth" ? await gate.promise : JSON.stringify({ result: USAGE_TEXT });
    });

    const refreshing = h.service.refresh("manual");

    await expect(h.service.logout()).resolves.toBe(true);
    expect(rows(h.db, "provider_snapshot")).toEqual([]);

    gate.resolve(JSON.stringify(AUTH_OK));

    await expect(refreshing).resolves.toEqual({ state: "skipped", reason: "logout" });
    expect(rows(h.db, "provider_snapshot")).toEqual([]);
    expect(rows(h.db, "provider_error")).toEqual([]);
  });

  test("進行中の取得が失敗しても、ログアウト後に error を書き戻さない", async () => {
    const gate = deferred<string>();
    const h = harness(async (args) => {
      if (args[0] === "auth" && args[1] === "logout") {
        return "";
      }

      return args[0] === "auth" ? await gate.promise : JSON.stringify({ result: USAGE_TEXT });
    });

    const refreshing = h.service.refresh("manual");

    await expect(h.service.logout()).resolves.toBe(true);

    gate.resolve(JSON.stringify({ loggedIn: false, authMethod: "none" }));

    await expect(refreshing).resolves.toEqual({ state: "skipped", reason: "logout" });
    expect(rows(h.db, "provider_error")).toEqual([]);
  });

  test("ログアウト中の取得は CLI を起動せず、すぐに skipped: logout を返す", async () => {
    const gate = deferred<void>();
    const h = harness(async (args) => {
      if (args[0] === "auth" && args[1] === "logout") {
        await gate.promise;

        return "";
      }

      return await defaultRun(args);
    });

    const loggingOut = h.service.logout();

    await expect(h.service.refresh("auto")).resolves.toEqual({ state: "skipped", reason: "logout" });
    expect(h.statusCalls()).toBe(0);

    gate.resolve();

    await expect(loggingOut).resolves.toBe(true);
  });

  test("CLI の失敗では状態を残し、次の取得は通常どおり動く", async () => {
    const h = harness(async (args) => {
      if (args[0] === "auth" && args[1] === "logout") {
        throw new ClaudeCliError("exit", "Claude の CLI が失敗しました");
      }

      return await defaultRun(args);
    });

    saveProviderSnapshot(h.db, "claude", claudeSnapshot(BASE_TIME - 5 * MINUTE));

    await expect(h.service.logout()).resolves.toBe(false);
    expect(rows(h.db, "provider_snapshot")).toHaveLength(1);

    await expect(h.service.refresh("manual")).resolves.toEqual({ state: "refreshed" });
  });

  test("DB の削除に失敗したら 503 用に false を返し、loggingOut は下ろす", async () => {
    const h = harness();

    // 資格情報は消えているのに状態が残る中間状態。次の取得で上書きできることだけを確かめる。
    h.db.db.exec("DROP TABLE provider_snapshot");

    await expect(h.service.logout()).resolves.toBe(false);
    await expect(h.service.refresh("manual")).resolves.not.toEqual({ state: "skipped", reason: "logout" });
  });

  test("成功で手動の 60 秒の下限をリセットする", async () => {
    const h = harness();

    await expect(h.service.refresh("manual")).resolves.toEqual({ state: "refreshed" });
    await expect(h.service.refresh("manual")).resolves.toEqual({ state: "skipped", reason: "cooldown" });

    await expect(h.service.logout()).resolves.toBe(true);

    h.advance(CLAUDE_MANUAL_COOLDOWN_MS - 1);

    await expect(h.service.refresh("manual")).resolves.toEqual({ state: "refreshed" });
    expect(h.statusCalls()).toBe(2);
  });

  test("CLI の出力はログにも DB にも残さない", async () => {
    const h = harness(async (args) => {
      if (args[0] === "auth" && args[1] === "logout") {
        return "SENTINEL-LOGOUT-OUTPUT";
      }

      return await defaultRun(args);
    });

    await expect(h.service.logout()).resolves.toBe(true);

    expect(h.logs.join("\n")).not.toContain("SENTINEL");
    expect(JSON.stringify(loadProviderUsage(h.db, ["claude"]))).not.toContain("SENTINEL");
  });

  test("同時のログアウトは single-flight で 1 回にまとめる", async () => {
    const gate = deferred<void>();
    const h = harness(async (args) => {
      if (args[0] === "auth" && args[1] === "logout") {
        await gate.promise;

        return "";
      }

      return await defaultRun(args);
    });

    const [first, second] = [h.service.logout(), h.service.logout()];

    gate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(h.logoutCalls()).toBe(1);
  });
});

describe("ログアウト後に設定ファイル由来の認証が残る場合", () => {
  test("api_key_helper は消えず、次の取得で subscription_required が戻る", async () => {
    const h = harness(async (args) => {
      if (args[0] === "auth" && args[1] === "logout") {
        return "";
      }

      // 設定ファイルの API キーは `claude auth logout` の対象外。
      return args[0] === "auth"
        ? JSON.stringify({ loggedIn: true, authMethod: "api_key_helper" })
        : JSON.stringify({ result: USAGE_TEXT });
    });

    await expect(h.service.logout()).resolves.toBe(true);
    expect(rows(h.db, "provider_snapshot")).toEqual([]);

    await expect(h.service.refresh("manual")).resolves.toEqual({
      state: "failed",
      error: "subscription_required",
    });
    expect(rows(h.db, "provider_error")).toHaveLength(1);
  });
});
