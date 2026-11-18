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
import { createSampler, PAUSED_RETRY_INTERVAL_MS, type UsageFetcher } from "../src/server/sampler";
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
      intervalFor: () => 300_000,
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

  test("accountId を含む source id でもログには logLabel だけを出す", async () => {
    const handle = open();
    const logs: string[] = [];
    const sampler = createSampler({
      db: handle,
      fetchers: () => [
        {
          sourceId: "codex:account-1",
          provider: CODEX_PROVIDER,
          logLabel: CODEX_PROVIDER.id,
          fetch: async () => {
            throw new ProviderError("upstream", "利用枠を取得できませんでした");
          },
        },
      ],
      intervalFor: () => 300_000,
      now: () => BASE_TIME,
      log: (message) => logs.push(message),
    });

    await sampler.kick();

    expect(logs).toEqual(["codex: upstream (利用枠を取得できませんでした)"]);
    expect(JSON.stringify(logs)).not.toContain("account-1");
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
      intervalFor: () => 300_000,
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
      intervalFor: () => 300_000,
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
      intervalFor: () => 300_000,
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
      intervalFor: () => 300_000,
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
      intervalFor: () => 300_000,
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
      intervalFor: () => 300_000,
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
      intervalFor: () => 300_000,
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
      intervalFor: () => 300_000,
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

describe("provider ごとの間隔", () => {
  const MINUTE = 60 * 1000;

  function scheduled(): {
    sampler: ReturnType<typeof createSampler>;
    calls: string[];
    advance: (ms: number) => void;
  } {
    const handle = open();
    const calls: string[] = [];
    let clock = BASE_TIME;
    const sampler = createSampler({
      db: handle,
      fetchers: () => [
        codexFetcher(async () => {
          calls.push("codex");

          return usageSnapshot({ capturedAt: clock });
        }),
        accountFetcher(async () => {
          calls.push("opencode");

          return usageSnapshot({ provider: "opencode-go", name: "OpenCode Go", capturedAt: clock });
        }),
      ],
      intervalFor: (provider) => (provider === "codex" ? 5 * MINUTE : 10 * MINUTE),
      now: () => clock,
      log: () => {},
    });

    return {
      sampler,
      calls,
      advance(ms) {
        clock += ms;
      },
    };
  }

  test("予定を過ぎた source だけを取り直す", async () => {
    const { sampler, calls, advance } = scheduled();

    await sampler.tick();
    expect(calls).toEqual(["codex", "opencode"]);

    advance(5 * MINUTE);
    await sampler.tick();
    expect(calls).toEqual(["codex", "opencode", "codex"]);

    advance(5 * MINUTE);
    await sampler.tick();
    expect(calls).toEqual(["codex", "opencode", "codex", "codex", "opencode"]);
  });

  test("kick は指定した provider だけを取り直す", async () => {
    const { sampler, calls } = scheduled();

    await sampler.tick();
    await sampler.kick("opencode-go");

    expect(calls).toEqual(["codex", "opencode", "opencode"]);
  });

  test("reschedule は次回予定を前倒しし、nextFetchAt に出す", async () => {
    const handle = open();
    let clock = BASE_TIME;
    let interval = 60 * MINUTE;
    const sampler = createSampler({
      db: handle,
      fetchers: () => [codexFetcher(async () => usageSnapshot({ capturedAt: clock }))],
      intervalFor: () => interval,
      now: () => clock,
      log: () => {},
    });

    await sampler.tick();
    expect(sampler.nextFetchAt("codex")).toBe(BASE_TIME + 60 * MINUTE);

    interval = 5 * MINUTE;
    sampler.reschedule("codex");
    expect(sampler.nextFetchAt("codex")).toBe(BASE_TIME + 5 * MINUTE);

    // 長くしても、既に近い予定は遅らせない。
    interval = 60 * MINUTE;
    sampler.reschedule("codex");
    expect(sampler.nextFetchAt("codex")).toBe(BASE_TIME + 5 * MINUTE);
  });

  test("1 つの source の取得中でも、別の source は予定どおり取る", async () => {
    const handle = open();
    const gate = deferred();
    const calls: string[] = [];
    let clock = BASE_TIME;
    const sampler = createSampler({
      db: handle,
      fetchers: () => [
        codexFetcher(async () => {
          calls.push("codex");
          await gate.promise;

          return usageSnapshot({ capturedAt: clock });
        }),
        accountFetcher(async () => {
          calls.push("opencode");

          return usageSnapshot({ provider: "opencode-go", name: "OpenCode Go", capturedAt: clock });
        }),
      ],
      intervalFor: (provider) => (provider === "codex" ? 60 * MINUTE : 5 * MINUTE),
      now: () => clock,
      log: () => {},
    });

    const first = sampler.tick();

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toEqual(["codex", "opencode"]);

    clock += 5 * MINUTE;
    await sampler.tick();
    expect(calls).toEqual(["codex", "opencode", "opencode"]);

    gate.resolve();
    await first;
  });
});

describe("排他区間中の tick", () => {
  test("変更の待機中に tick が始めた取得は、削除した snapshot を書き戻さない", async () => {
    const handle = open();
    const codexGate = deferred();
    const accountGate = deferred();
    const calls: string[] = [];
    let accounts = 0;
    const sampler = createSampler({
      db: handle,
      fetchers: () => [
        codexFetcher(async () => {
          calls.push("codex");
          await codexGate.promise;

          return usageSnapshot({ capturedAt: BASE_TIME });
        }),
        ...Array.from({ length: accounts }, (_, index) => ({
          sourceId: `opencode-go:0000000${index}-0000-4000-8000-000000000000`,
          provider: OPENCODE_PROVIDER,
          fetch: async () => {
            calls.push(`account-${index}`);
            await accountGate.promise;

            return usageSnapshot({ provider: "opencode-go", name: "OpenCode Go", capturedAt: BASE_TIME });
          },
        })),
      ],
      intervalFor: () => 300_000,
      now: () => BASE_TIME,
      log: () => {},
    });

    // Codex の取得を進行中にし、その待機中にアカウントを増やす。
    const inFlight = sampler.tick();

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toEqual(["codex"]);

    accounts = 1;

    const logout = sampler.exclusive(() => deleteProviderUsage(handle, "codex"), { refresh: false });

    // 変更中に tick が来ても、新しい取得は始めない。
    await sampler.tick();
    expect(calls).toEqual(["codex"]);

    codexGate.resolve();
    await Promise.all([inFlight, logout]);

    // 開始していないので、書き戻す取得も無い。
    accountGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(calls).toEqual(["codex"]);
    const accountSourceId = "opencode-go:00000000-0000-4000-8000-000000000000";

    expect(loadProviderUsage(handle, [accountSourceId]).get(accountSourceId)?.snapshot).toBeNull();
  });
});

describe("provider を絞った排他区間", () => {
  test("別 provider の変更待ちは、関係ない provider の取得を止めない", async () => {
    const handle = open();
    const gate = deferred();
    const calls: string[] = [];
    let clock = BASE_TIME;
    const sampler = createSampler({
      db: handle,
      fetchers: () => [
        codexFetcher(async () => {
          calls.push("codex");

          return usageSnapshot({ capturedAt: clock });
        }),
        accountFetcher(async () => {
          calls.push("opencode");
          await gate.promise;

          return usageSnapshot({ provider: "opencode-go", name: "OpenCode Go", capturedAt: clock });
        }),
      ],
      intervalFor: () => 5 * 60 * 1000,
      now: () => clock,
      log: () => {},
    });

    const first = sampler.tick();

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toEqual(["codex", "opencode"]);

    clock += 5 * 60 * 1000;

    const mutation = sampler.exclusive(() => {}, { provider: "opencode-go", refresh: false });

    await sampler.tick();
    expect(calls).toEqual(["codex", "opencode", "codex"]);

    gate.resolve();
    await Promise.all([first, mutation]);
  });
});

describe("停止中の source", () => {
  const RETRY = PAUSED_RETRY_INTERVAL_MS;

  function pausedSampler(options: {
    fetch: () => Promise<ReturnType<typeof usageSnapshot>>;
    pausedUntil?: number | null;
    clock: () => number;
  }) {
    return createSampler({
      db: open(),
      fetchers: () => [
        {
          sourceId: ACCOUNT_SOURCE_ID,
          provider: OPENCODE_PROVIDER,
          pausedUntil: options.pausedUntil ?? null,
          fetch: options.fetch,
        },
      ],
      intervalFor: () => 300_000,
      now: options.clock,
      log: () => {},
    });
  }

  test("再確認時刻までは tick で取らず、過ぎたら取る", async () => {
    let clock = BASE_TIME;
    const calls: string[] = [];
    const sampler = pausedSampler({
      clock: () => clock,
      pausedUntil: BASE_TIME + RETRY,
      fetch: async () => {
        calls.push("fetch");

        return usageSnapshot({ provider: "opencode-go", name: "OpenCode Go", capturedAt: clock });
      },
    });

    await sampler.tick();
    expect(calls).toEqual([]);

    clock += RETRY;
    await sampler.tick();
    expect(calls).toEqual(["fetch"]);
    // 停止中に取れた場合も、次は 6 時間後ではなく通常の間隔へ戻す。
    expect(sampler.nextFetchAt(ACCOUNT_SOURCE_ID)).toBe(BASE_TIME + RETRY + 300_000);
  });

  test("refreshSource は停止中でも取り直す", async () => {
    let clock = BASE_TIME;
    const calls: string[] = [];
    const sampler = pausedSampler({
      clock: () => clock,
      pausedUntil: BASE_TIME + RETRY,
      fetch: async () => {
        calls.push("fetch");

        return usageSnapshot({ provider: "opencode-go", name: "OpenCode Go", capturedAt: clock });
      },
    });

    await sampler.refreshSource(ACCOUNT_SOURCE_ID);
    expect(calls).toEqual(["fetch"]);
    expect(sampler.nextFetchAt(ACCOUNT_SOURCE_ID)).toBe(BASE_TIME + 300_000);
  });

  test("subscription_required で失敗したら 6 時間後まで取り直さない", async () => {
    const clock = BASE_TIME;
    let calls = 0;
    const sampler = pausedSampler({
      clock: () => clock,
      fetch: async () => {
        calls += 1;

        throw new ProviderError("subscription_required", "OpenCode Go の契約が必要です");
      },
    });

    await sampler.tick();
    expect(calls).toBe(1);
    expect(sampler.nextFetchAt(ACCOUNT_SOURCE_ID)).toBe(BASE_TIME + RETRY);

    await sampler.tick();
    expect(calls).toBe(1);
  });
});
