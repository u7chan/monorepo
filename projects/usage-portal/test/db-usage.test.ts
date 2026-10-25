// snapshot / error / sample の保存と保持期間を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteProviderUsage,
  loadProviderUsage,
  loadSamples,
  openDatabase,
  pruneSamples,
  saveProviderError,
  saveProviderSnapshot,
  type DatabaseHandle,
} from "../src/server/db";
import { BASE_TIME, usageSnapshot } from "./support";

const dirs: string[] = [];
const handles: DatabaseHandle[] = [];

function open(): DatabaseHandle {
  const dir = mkdtempSync(join(tmpdir(), "usage-portal-db-usage-"));
  const handle = openDatabase(dir);

  dirs.push(dir);
  handles.push(handle);

  return handle;
}

function snapshotRow(handle: DatabaseHandle, provider: string) {
  return handle.db.query("SELECT provider, captured_at FROM provider_snapshot WHERE provider = ?").get(provider);
}

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.close();
  }

  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("saveProviderSnapshot", () => {
  test("snapshot を upsert し、窓ごとの sample を追記し、error を消す", () => {
    const handle = open();

    saveProviderError(handle, "codex", { code: "upstream", message: "HTTP 500", at: BASE_TIME - 1000 });
    saveProviderSnapshot(handle, usageSnapshot());
    saveProviderSnapshot(
      handle,
      usageSnapshot({
        capturedAt: BASE_TIME + 300_000,
        windows: [
          { id: "primary", label: "週次", durationSeconds: 604_800, usedPercent: 70, resetsAt: null },
          { id: "secondary", label: "ローリング", durationSeconds: 18_000, usedPercent: 10, resetsAt: null },
        ],
      }),
    );

    expect(handle.db.query("SELECT COUNT(*) AS count FROM provider_snapshot").get()).toEqual({ count: 1 });
    expect(handle.db.query("SELECT COUNT(*) AS count FROM usage_sample").get()).toEqual({ count: 3 });
    expect(handle.db.query("SELECT COUNT(*) AS count FROM provider_error").get()).toEqual({ count: 0 });
    expect(loadProviderUsage(handle, ["codex"]).get("codex")?.snapshot?.capturedAt).toBe(BASE_TIME + 300_000);
  });

  test("sample の追記に失敗したら snapshot の更新ごと巻き戻す", () => {
    const handle = open();

    handle.db.exec("DROP TABLE usage_sample");

    expect(() => saveProviderSnapshot(handle, usageSnapshot())).toThrow();
    expect(snapshotRow(handle, "codex")).toBeNull();
  });

  test("同じ取得時刻の sample は上書きする", () => {
    const handle = open();

    saveProviderSnapshot(handle, usageSnapshot());
    saveProviderSnapshot(
      handle,
      usageSnapshot({
        windows: [{ id: "primary", label: "週次", durationSeconds: 604_800, usedPercent: 80, resetsAt: null }],
      }),
    );

    expect(loadSamples(handle, "codex", "primary", 0)).toEqual([{ at: BASE_TIME, usedPercent: 80 }]);
  });
});

describe("saveProviderError", () => {
  test("error を upsert し、前回の snapshot を残す", () => {
    const handle = open();

    saveProviderSnapshot(handle, usageSnapshot());
    saveProviderError(handle, "codex", { code: "upstream", message: "HTTP 429", at: BASE_TIME + 1 });
    saveProviderError(handle, "codex", { code: "schema", message: "応答を解釈できませんでした", at: BASE_TIME + 2 });

    const stored = loadProviderUsage(handle, ["codex"]).get("codex");

    expect(stored?.error).toEqual({ code: "schema", message: "応答を解釈できませんでした", at: BASE_TIME + 2 });
    expect(stored?.snapshot?.windows).toHaveLength(1);
  });
});

describe("loadProviderUsage", () => {
  test("行が無い provider も null として返す", () => {
    const handle = open();
    const stored = loadProviderUsage(handle, ["codex", "opencode-go"]);

    expect(stored.get("codex")).toEqual({ snapshot: null, error: null });
    expect(stored.get("opencode-go")).toEqual({ snapshot: null, error: null });
  });

  test("壊れた snapshot_json は読めなかったものとして扱う", () => {
    const handle = open();

    handle.db
      .query("INSERT INTO provider_snapshot (provider, captured_at, snapshot_json) VALUES (?, ?, ?)")
      .run("codex", BASE_TIME, "{");

    expect(loadProviderUsage(handle, ["codex"]).get("codex")?.snapshot).toBeNull();
  });
});

describe("loadSamples", () => {
  test("指定時刻以降を古い順で返す", () => {
    const handle = open();

    for (const offset of [0, 600_000, 1_200_000]) {
      saveProviderSnapshot(
        handle,
        usageSnapshot({
          capturedAt: BASE_TIME + offset,
          windows: [
            { id: "primary", label: "週次", durationSeconds: 604_800, usedPercent: offset / 600_000, resetsAt: null },
          ],
        }),
      );
    }

    expect(loadSamples(handle, "codex", "primary", BASE_TIME + 600_000)).toEqual([
      { at: BASE_TIME + 600_000, usedPercent: 1 },
      { at: BASE_TIME + 1_200_000, usedPercent: 2 },
    ]);
  });
});

describe("pruneSamples / deleteProviderUsage", () => {
  test("保持期間より古い sample だけを消す", () => {
    const handle = open();
    const day = 24 * 60 * 60 * 1000;

    saveProviderSnapshot(handle, usageSnapshot({ capturedAt: BASE_TIME - 40 * day }));
    saveProviderSnapshot(handle, usageSnapshot({ capturedAt: BASE_TIME }));

    expect(pruneSamples(handle, BASE_TIME - 30 * day)).toBe(1);
    expect(loadSamples(handle, "codex", "primary", 0).map((point) => point.at)).toEqual([BASE_TIME]);
  });

  test("サインアウトでは snapshot と error を消し、sample は残す", () => {
    const handle = open();

    saveProviderSnapshot(handle, usageSnapshot());
    saveProviderError(handle, "codex", { code: "upstream", message: "HTTP 500", at: BASE_TIME });

    deleteProviderUsage(handle, "codex");

    expect(loadProviderUsage(handle, ["codex"]).get("codex")).toEqual({ snapshot: null, error: null });
    expect(loadSamples(handle, "codex", "primary", 0)).toHaveLength(1);
  });
});
