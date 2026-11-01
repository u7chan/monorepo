// snapshot / error / sample の保存と、source id 単位の掃除を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteLegacyOpenCodeUsage,
  deleteProviderState,
  deleteProviderUsage,
  loadProviderUsage,
  loadSamples,
  migrateCodexUsage,
  openDatabase,
  pruneOpenCodeUsage,
  pruneSamples,
  saveProviderError,
  saveProviderSnapshot,
  type DatabaseHandle,
} from "../src/server/db";
import { BASE_TIME, usageSnapshot } from "./support";

const dirs: string[] = [];
const handles: DatabaseHandle[] = [];
const MAIN_SOURCE_ID = "opencode-go:11111111-1111-4111-8111-111111111111";
const SUB_SOURCE_ID = "opencode-go:22222222-2222-4222-8222-222222222222";

function open(): DatabaseHandle {
  const dir = mkdtempSync(join(tmpdir(), "usage-portal-db-usage-"));
  const handle = openDatabase(dir);

  dirs.push(dir);
  handles.push(handle);

  return handle;
}

function snapshotRow(handle: DatabaseHandle, sourceId: string) {
  return handle.db.query("SELECT provider, captured_at FROM provider_snapshot WHERE provider = ?").get(sourceId);
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
  test("source id ごとに snapshot を upsert し、窓ごとの sample を追記し、error を消す", () => {
    const handle = open();

    saveProviderError(handle, "codex", { code: "upstream", message: "HTTP 500", at: BASE_TIME - 1000 });
    saveProviderSnapshot(handle, "codex", usageSnapshot());
    saveProviderSnapshot(
      handle,
      "codex",
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

  test("同じ snapshot でも source id が違えば別の行として保存する", () => {
    const handle = open();
    const snapshot = usageSnapshot({ provider: "opencode-go", name: "OpenCode Go" });

    saveProviderSnapshot(handle, MAIN_SOURCE_ID, snapshot);
    saveProviderSnapshot(handle, SUB_SOURCE_ID, snapshot);

    expect(handle.db.query("SELECT COUNT(*) AS count FROM provider_snapshot").get()).toEqual({ count: 2 });
    expect(snapshotRow(handle, MAIN_SOURCE_ID)).not.toBeNull();
    expect(snapshotRow(handle, SUB_SOURCE_ID)).not.toBeNull();
    // JSON の中の provider は provider id のまま。列だけが source id を持つ。
    expect(loadProviderUsage(handle, [MAIN_SOURCE_ID]).get(MAIN_SOURCE_ID)?.snapshot?.provider).toBe("opencode-go");
  });

  test("sample の追記に失敗したら snapshot の更新ごと巻き戻す", () => {
    const handle = open();

    handle.db.exec("DROP TABLE usage_sample");

    expect(() => saveProviderSnapshot(handle, "codex", usageSnapshot())).toThrow();
    expect(snapshotRow(handle, "codex")).toBeNull();
  });

  test("同じ取得時刻の sample は上書きする", () => {
    const handle = open();

    saveProviderSnapshot(handle, "codex", usageSnapshot());
    saveProviderSnapshot(
      handle,
      "codex",
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

    saveProviderSnapshot(handle, "codex", usageSnapshot());
    saveProviderError(handle, "codex", { code: "upstream", message: "HTTP 429", at: BASE_TIME + 1 });
    saveProviderError(handle, "codex", { code: "schema", message: "応答を解釈できませんでした", at: BASE_TIME + 2 });

    const stored = loadProviderUsage(handle, ["codex"]).get("codex");

    expect(stored?.error).toEqual({ code: "schema", message: "応答を解釈できませんでした", at: BASE_TIME + 2 });
    expect(stored?.snapshot?.windows).toHaveLength(1);
  });
});

describe("loadProviderUsage", () => {
  test("行が無い source も null として返す", () => {
    const handle = open();
    const stored = loadProviderUsage(handle, ["codex", MAIN_SOURCE_ID]);

    expect(stored.get("codex")).toEqual({ snapshot: null, error: null });
    expect(stored.get(MAIN_SOURCE_ID)).toEqual({ snapshot: null, error: null });
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
        "codex",
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

    saveProviderSnapshot(handle, "codex", usageSnapshot({ capturedAt: BASE_TIME - 40 * day }));
    saveProviderSnapshot(handle, "codex", usageSnapshot({ capturedAt: BASE_TIME }));

    expect(pruneSamples(handle, BASE_TIME - 30 * day)).toBe(1);
    expect(loadSamples(handle, "codex", "primary", 0).map((point) => point.at)).toEqual([BASE_TIME]);
  });

  test("削除は snapshot・error・sample をまとめて消し、他の source は残す", () => {
    const handle = open();

    saveProviderSnapshot(handle, "codex", usageSnapshot());
    saveProviderSnapshot(handle, MAIN_SOURCE_ID, usageSnapshot({ provider: "opencode-go", name: "OpenCode Go" }));
    saveProviderError(handle, MAIN_SOURCE_ID, { code: "upstream", message: "HTTP 500", at: BASE_TIME });

    deleteProviderUsage(handle, MAIN_SOURCE_ID);

    expect(loadProviderUsage(handle, [MAIN_SOURCE_ID]).get(MAIN_SOURCE_ID)).toEqual({ snapshot: null, error: null });
    expect(loadSamples(handle, MAIN_SOURCE_ID, "primary", 0)).toEqual([]);
    expect(loadProviderUsage(handle, ["codex"]).get("codex")?.snapshot?.windows).toHaveLength(1);
    expect(loadSamples(handle, "codex", "primary", 0)).toHaveLength(1);
  });
});

describe("deleteProviderState / migrateCodexUsage", () => {
  test("snapshot と error だけを消し、sample は残す", () => {
    const handle = open();

    saveProviderSnapshot(handle, "codex:account-1", usageSnapshot());
    saveProviderError(handle, "codex:account-1", { code: "upstream", message: "HTTP 500", at: BASE_TIME });

    deleteProviderState(handle, "codex:account-1");

    expect(loadProviderUsage(handle, ["codex:account-1"]).get("codex:account-1")).toEqual({
      snapshot: null,
      error: null,
    });
    expect(loadSamples(handle, "codex:account-1", "primary", 0)).toHaveLength(1);
  });

  test("旧キーの snapshot と sample を現在のアカウントへ移し、error は移さない", () => {
    const handle = open();

    saveProviderSnapshot(handle, "codex", usageSnapshot({ capturedAt: BASE_TIME - 300_000 }));
    saveProviderSnapshot(handle, "codex", usageSnapshot());
    saveProviderError(handle, "codex", { code: "upstream", message: "HTTP 500", at: BASE_TIME + 1 });

    migrateCodexUsage(handle, "codex:account-1");

    expect(loadProviderUsage(handle, ["codex"]).get("codex")).toEqual({ snapshot: null, error: null });
    expect(loadSamples(handle, "codex", "primary", 0)).toEqual([]);

    const moved = loadProviderUsage(handle, ["codex:account-1"]).get("codex:account-1");

    expect(moved?.snapshot?.capturedAt).toBe(BASE_TIME);
    expect(moved?.error).toBeNull();
    expect(loadSamples(handle, "codex:account-1", "primary", 0)).toHaveLength(2);
  });

  test("サインアウト中の not_connected を再起動時に引き継がない", () => {
    const handle = open();

    saveProviderSnapshot(handle, "codex:account-1", usageSnapshot());
    saveProviderError(handle, "codex", {
      code: "not_connected",
      message: "Codex にサインインしていません",
      at: BASE_TIME,
    });

    migrateCodexUsage(handle, "codex:account-1");

    const stored = loadProviderUsage(handle, ["codex:account-1"]).get("codex:account-1");

    expect(stored?.snapshot?.capturedAt).toBe(BASE_TIME);
    expect(stored?.error).toBeNull();
  });

  test("移し先に既にある行を上書きしない", () => {
    const handle = open();

    saveProviderSnapshot(
      handle,
      "codex",
      usageSnapshot({
        windows: [{ id: "primary", label: "週次", durationSeconds: 604_800, usedPercent: 10, resetsAt: null }],
      }),
    );
    saveProviderSnapshot(handle, "codex:account-1", usageSnapshot());

    migrateCodexUsage(handle, "codex:account-1");

    expect(loadSamples(handle, "codex:account-1", "primary", 0)).toEqual([{ at: BASE_TIME, usedPercent: 62 }]);
    expect(loadSamples(handle, "codex", "primary", 0)).toEqual([]);
  });

  test("未接続のキーを渡したら何もしない", () => {
    const handle = open();

    saveProviderSnapshot(handle, "codex", usageSnapshot());

    migrateCodexUsage(handle, "codex");

    expect(loadSamples(handle, "codex", "primary", 0)).toHaveLength(1);
  });
});

describe("起動時の掃除", () => {
  test("旧 opencode-go の行だけを消し、Codex の snapshot は残す", () => {
    const handle = open();

    saveProviderSnapshot(handle, "codex", usageSnapshot());
    saveProviderSnapshot(handle, "opencode-go", usageSnapshot({ provider: "opencode-go", name: "OpenCode Go" }));
    saveProviderError(handle, "opencode-go", { code: "config", message: "旧キー", at: BASE_TIME });

    expect(deleteLegacyOpenCodeUsage(handle)).toBeGreaterThan(0);

    expect(loadProviderUsage(handle, ["opencode-go"]).get("opencode-go")).toEqual({ snapshot: null, error: null });
    expect(loadSamples(handle, "opencode-go", "primary", 0)).toEqual([]);
    expect(loadProviderUsage(handle, ["codex"]).get("codex")?.snapshot?.windows).toHaveLength(1);
  });

  test("登録の無い source id の行だけを消す", () => {
    const handle = open();

    saveProviderSnapshot(handle, MAIN_SOURCE_ID, usageSnapshot({ provider: "opencode-go", name: "OpenCode Go" }));
    saveProviderSnapshot(handle, SUB_SOURCE_ID, usageSnapshot({ provider: "opencode-go", name: "OpenCode Go" }));
    saveProviderSnapshot(handle, "codex", usageSnapshot());

    expect(pruneOpenCodeUsage(handle, [MAIN_SOURCE_ID])).toBeGreaterThan(0);

    expect(loadProviderUsage(handle, [MAIN_SOURCE_ID]).get(MAIN_SOURCE_ID)?.snapshot).not.toBeNull();
    expect(loadProviderUsage(handle, [SUB_SOURCE_ID]).get(SUB_SOURCE_ID)?.snapshot).toBeNull();
    expect(loadSamples(handle, SUB_SOURCE_ID, "primary", 0)).toEqual([]);
    expect(loadProviderUsage(handle, ["codex"]).get("codex")?.snapshot).not.toBeNull();
  });

  test("アカウントが 1 件も無ければ opencode-go: で始まる行を全部消す", () => {
    const handle = open();

    saveProviderSnapshot(handle, MAIN_SOURCE_ID, usageSnapshot({ provider: "opencode-go", name: "OpenCode Go" }));
    saveProviderSnapshot(handle, "codex", usageSnapshot());

    pruneOpenCodeUsage(handle, []);

    expect(loadProviderUsage(handle, [MAIN_SOURCE_ID]).get(MAIN_SOURCE_ID)?.snapshot).toBeNull();
    expect(loadProviderUsage(handle, ["codex"]).get("codex")?.snapshot).not.toBeNull();
  });
});
