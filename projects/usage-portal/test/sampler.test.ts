// sampler の single-flight と、provider ごとに独立して失敗する契約を固定する。
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
import { createSampler } from "../src/server/sampler";
import { BASE_TIME, usageSnapshot } from "./support";

const dirs: string[] = [];
const handles: DatabaseHandle[] = [];

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

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.close();
  }

  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createSampler", () => {
  test("kick で取得して snapshot を保存し、片方の失敗は他方を壊さない", async () => {
    const handle = open();
    const logs: string[] = [];
    const sampler = createSampler({
      db: handle,
      fetchers: [
        { provider: CODEX_PROVIDER, fetch: async () => usageSnapshot() },
        {
          provider: OPENCODE_PROVIDER,
          fetch: async () => {
            throw new ProviderError("config", "OpenCode Go の API キーが設定されていません");
          },
        },
      ],
      intervalMs: 300_000,
      now: () => BASE_TIME,
      log: (message) => logs.push(message),
    });

    await sampler.kick();

    const stored = loadProviderUsage(handle, ["codex", "opencode-go"]);

    expect(stored.get("codex")?.snapshot?.windows).toHaveLength(1);
    expect(stored.get("opencode-go")?.snapshot).toBeNull();
    expect(stored.get("opencode-go")?.error).toEqual({
      code: "config",
      message: "OpenCode Go の API キーが設定されていません",
      at: BASE_TIME,
    });
    expect(logs).toEqual(["opencode-go: config (OpenCode Go の API キーが設定されていません)"]);
  });

  test("失敗しても前回の snapshot を残す", async () => {
    const handle = open();

    saveProviderSnapshot(handle, usageSnapshot({ capturedAt: BASE_TIME - 600_000 }));

    const sampler = createSampler({
      db: handle,
      fetchers: [
        {
          provider: CODEX_PROVIDER,
          fetch: async () => {
            throw new ProviderError("upstream", "Codex の取得に失敗しました（HTTP 500）");
          },
        },
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

  test("想定外の例外文は保存しない", async () => {
    const handle = open();
    const sampler = createSampler({
      db: handle,
      fetchers: [
        {
          provider: CODEX_PROVIDER,
          fetch: async () => {
            throw new Error("token=secret-sentinel");
          },
        },
      ],
      intervalMs: 300_000,
      now: () => BASE_TIME,
      log: () => {},
    });

    await sampler.kick();

    const stored = loadProviderUsage(handle, ["codex"]).get("codex");

    expect(stored?.error).toEqual({ code: "upstream", message: "利用枠を取得できませんでした", at: BASE_TIME });
  });

  test("取得は同時に走らせず、kick は進行中の完了後にもう 1 回走らせる", async () => {
    const handle = open();
    const gate = deferred();
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const sampler = createSampler({
      db: handle,
      fetchers: [
        {
          provider: CODEX_PROVIDER,
          fetch: async () => {
            calls += 1;
            active += 1;
            maxActive = Math.max(maxActive, active);
            await gate.promise;
            active -= 1;

            return usageSnapshot({ capturedAt: BASE_TIME + calls });
          },
        },
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

    saveProviderSnapshot(handle, usageSnapshot());
    deleteProviderUsage(handle, "codex");

    const sampler = createSampler({
      db: handle,
      fetchers: [
        {
          provider: CODEX_PROVIDER,
          fetch: async () => {
            throw new ProviderError("not_connected", "Codex にサインインしていません");
          },
        },
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
  test("進行中の取得が終わってから fn を実行し、その後の取得で古い snapshot を書き戻さない", async () => {
    const handle = open();
    const gate = deferred();
    let signedIn = true;
    const sampler = createSampler({
      db: handle,
      fetchers: [
        {
          provider: CODEX_PROVIDER,
          fetch: async () => {
            if (!signedIn) {
              throw new ProviderError("not_connected", "Codex にサインインしていません");
            }

            await gate.promise;

            return usageSnapshot();
          },
        },
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
