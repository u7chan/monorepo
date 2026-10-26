// sampler の single-flight、source ごとの独立失敗、fetchers の毎回評価を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteProviderUsage,
  loadProviderUsage,
  openDatabase,
  saveProviderSnapshot,
  type DatabaseHandle,
} from "../src/server/db";
import { CODEX_PROVIDER, OPENCODE_PROVIDER } from "../src/server/providers";
import { ProviderError } from "../src/server/providers/types";
import { createSampler, type UsageFetcher } from "../src/server/sampler";
import { BASE_TIME, usageSnapshot } from "./support";

const dirs: string[] = [];
const handles: DatabaseHandle[] = [];
const ACCOUNT_SOURCE_ID = "opencode-go:11111111-1111-4111-8111-111111111111";

function open(): DatabaseHandle {
  const dir = mkdtempSync(join(tmpdir(), "usage-portal-sampler-"));
  const handle = openDatabase(dir);

  dirs.push(dir);
  handles.push(handle);

  return handle;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

function codexFetcher(fetch: () => Promise<ReturnType<typeof usageSnapshot>>): UsageFetcher {
  return { sourceId: CODEX_PROVIDER.id, provider: CODEX_PROVIDER, fetch };
}

function accountFetcher(fetch: () => Promise<ReturnType<typeof usageSnapshot>>): UsageFetcher {
  return { sourceId: ACCOUNT_SOURCE_ID, provider: OPENCODE_PROVIDER, fetch };
}

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.close();
  }

  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createSampler", () => {
  test("kick で取得して source id ごとに保存し、片方の失敗は他方を壊さない", async () => {
    const handle = open();
    const logs: string[] = [];
    const sampler = createSampler({
      db: handle,
      fetchers: () => [
        codexFetcher(async () => usageSnapshot()),
        accountFetcher(async () => {
          throw new ProviderError("config", "OpenCode Go の API キーが設定されていません");
        }),
      ],
      intervalMs: 300_000,
      now: () => BASE_TIME,
      log: (message) => logs.push(message),
    });

    await sampler.kick();

    const stored = loadProviderUsage(handle, ["codex", ACCOUNT_SOURCE_ID]);

    expect(stored.get("codex")?.snapshot?.windows).toHaveLength(1);
    expect(stored.get(ACCOUNT_SOURCE_ID)?.snapshot).toBeNull();
    expect(stored.get(ACCOUNT_SOURCE_ID)?.error).toEqual({
      code: "config",
      message: "OpenCode Go の API キーが設定されていません",
      at: BASE_TIME,
    });
    expect(logs).toEqual([`opencode-go ${ACCOUNT_SOURCE_ID}: config (OpenCode Go の API キーが設定されていません)`]);
  });

  test("アカウントの追加・削除が次の取得から反映される", async () => {
    const handle = open();
    let accounts = 0;
    const calls: string[] = [];
    const sampler = createSampler({
      db: handle,
      fetchers: () =>
        Array.from({ length: accounts }, (_, index) => ({
          sourceId: `opencode-go:0000000${index}-0000-4000-8000-000000000000`,
          provider: OPENCODE_PROVIDER,
          fetch: async () => {
            calls.push(`account-${index}`);

            return usageSnapshot({ provider: "opencode-go", name: "OpenCode Go", capturedAt: BASE_TIME });
          },
        })),
      intervalMs: 300_000,
      now: () => BASE_TIME,
      log: () => {},
    });

    await sampler.kick();
    expect(calls).toEqual([]);

    accounts = 2;
    await sampler.kick();
    expect(calls).toEqual(["account-0", "account-1"]);

    accounts = 1;
    await sampler.kick();
    expect(calls).toEqual(["account-0", "account-1", "account-0"]);
  });

  test("取得の途中で fetchers が変わっても、その回の対象は増えない", async () => {
    const handle = open();
    const gate = deferred();
    const calls: string[] = [];
    let accounts = 1;
    const sampler = createSampler({
      db: handle,
      fetchers: () => {
        const count = accounts;
        accounts = 2;

        return Array.from({ length: count }, (_, index) => ({
          sourceId: `opencode-go:0000000${index}-0000-4000-8000-000000000000`,
          provider: OPENCODE_PROVIDER,
          fetch: async () => {
            calls.push(`account-${index}`);
            await gate.promise;

            return usageSnapshot({ provider: "opencode-go", name: "OpenCode Go", capturedAt: BASE_TIME });
          },
        }));
      },
      intervalMs: 300_000,
      now: () => BASE_TIME,
      log: () => {},
    });

    const run = sampler.kick();

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toEqual(["account-0"]);

    gate.resolve();
    await run;

    expect(calls).toEqual(["account-0"]);
  });

  test("失敗しても前回の snapshot を残す", async () => {
    const handle = open();

    saveProviderSnapshot(handle, "codex", usageSnapshot({ capturedAt: BASE_TIME - 600_000 }));

    const sampler = createSampler({
      db: handle,
      fetchers: () => [
        codexFetcher(async () => {
          throw new ProviderError("upstream", "Codex の取得に失敗しました（HTTP 500）");
        }),
      ],
      intervalMs: 300_000,
      now: () => BASE_TIME,
      log: () => {},
    });

    await sampler.kick();

    const stored = loadProviderUsage(handle, ["codex"]).get("codex");

    expect(stored?.snapshot?.capturedAt).toBe(BASE_TIME - 600_000);
    expect(stored?.error?.code).toBe("upstream");
  });

  test("想定外の例外文は保存せず、ログにも出さない", async () => {
    const handle = open();
    const logs: string[] = [];
    const sampler = createSampler({
      db: handle,
      fetchers: () => [
        accountFetcher(async () => {
          throw new Error("token=secret-sentinel");
        }),
      ],
      intervalMs: 300_000,
      now: () => BASE_TIME,
      log: (message) => logs.push(message),
    });

    await sampler.kick();

    const stored = loadProviderUsage(handle, [ACCOUNT_SOURCE_ID]).get(ACCOUNT_SOURCE_ID);

    expect(stored?.error).toEqual({ code: "upstream", message: "利用枠を取得できませんでした", at: BASE_TIME });
    expect(logs).toEqual([`opencode-go ${ACCOUNT_SOURCE_ID}: upstream (利用枠を取得できませんでした)`]);
    expect(JSON.stringify(logs)).not.toContain("secret-sentinel");
  });

  test("取得は同時に走らせず、kick は進行中の完了後にもう 1 回走らせる", async () => {
    const handle = open();
    const gate = deferred();
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const sampler = createSampler({
      db: handle,
      fetchers: () => [
        codexFetcher(async () => {
          calls += 1;
          active += 1;
          maxActive = Math.max(maxActive, active);
          await gate.promise;
          active -= 1;

          return usageSnapshot({ capturedAt: BASE_TIME + calls });
        }),
      ],
      intervalMs: 300_000,
      now: () => BASE_TIME,
      log: () => {},
    });

    const first = sampler.kick();
    const second = sampler.kick();

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toBe(1);
    expect(maxActive).toBe(1);

    gate.resolve();
    await Promise.all([first, second]);

    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
    expect(loadProviderUsage(handle, ["codex"]).get("codex")?.snapshot?.capturedAt).toBe(BASE_TIME + 2);
  });

  test("サインアウトで消した snapshot を、取得失敗でも戻さない", async () => {
    const handle = open();

    saveProviderSnapshot(handle, "codex", usageSnapshot());
    deleteProviderUsage(handle, "codex");

    const sampler = createSampler({
      db: handle,
      fetchers: () => [
        codexFetcher(async () => {
          throw new ProviderError("not_connected", "Codex にサインインしていません");
        }),
      ],
      intervalMs: 300_000,
      now: () => BASE_TIME,
      log: () => {},
    });

    await sampler.kick();

    expect(loadProviderUsage(handle, ["codex"]).get("codex")?.snapshot).toBeNull();
  });
});

describe("exclusive", () => {
  test("積まれた exclusive を直列化し、前の変更後の取得が終わるまで次を始めない", async () => {
    const handle = open();
    const gate = deferred();
    const order: string[] = [];
    let calls = 0;
    const sampler = createSampler({
      db: handle,
      fetchers: () => [
        codexFetcher(async () => {
          calls += 1;
          order.push(`fetch${calls}`);

          if (calls === 1) {
            await gate.promise;
          }

          return usageSnapshot();
        }),
      ],
      intervalMs: 300_000,
      now: () => BASE_TIME,
      log: () => {},
    });

    const initial = sampler.kick();
    const change1 = sampler.exclusive(() => order.push("change1"));
    const change2 = sampler.exclusive(() => order.push("change2"));

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["fetch1"]);

    gate.resolve();
    await Promise.all([initial, change1, change2]);

    expect(order).toEqual(["fetch1", "change1", "fetch2", "change2", "fetch3"]);
  });

  test("進行中の取得が終わってから fn を実行し、その後の取得で古い snapshot を書き戻さない", async () => {
    const handle = open();
    const gate = deferred();
    let signedIn = true;
    const sampler = createSampler({
      db: handle,
      fetchers: () => [
        codexFetcher(async () => {
          if (!signedIn) {
            throw new ProviderError("not_connected", "Codex にサインインしていません");
          }

          await gate.promise;

          return usageSnapshot();
        }),
      ],
      intervalMs: 300_000,
      now: () => BASE_TIME,
      log: () => {},
    });

    // サインアウト前の資格情報で取得が始まり、応答を保留している状態を作る。
    const inFlight = sampler.kick();

    signedIn = false;

    const logout = sampler.exclusive(() => deleteProviderUsage(handle, "codex"));

    // 保留中の取得は排他区間の前には保存されない。
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(loadProviderUsage(handle, ["codex"]).get("codex")?.snapshot).toBeNull();

    gate.resolve();
    await Promise.all([inFlight, logout]);

    const stored = loadProviderUsage(handle, ["codex"]).get("codex");

    expect(stored?.snapshot).toBeNull();
    expect(stored?.error?.code).toBe("not_connected");
  });
});
