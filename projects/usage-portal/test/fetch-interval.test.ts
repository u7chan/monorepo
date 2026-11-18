// 画面とサーバーで共有する取得間隔の一覧と、保存値が無いときの既定値を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DatabaseHandle } from "../src/server/db";
import { createFetchIntervalStore } from "../src/server/fetch-intervals";
import {
  DEFAULT_FETCH_INTERVAL_MINUTES,
  FETCH_INTERVAL_OPTIONS_MINUTES,
  fetchIntervalMs,
  isFetchIntervalMinutes,
  isFetchIntervalProvider,
} from "../src/shared/fetch-interval";

const dirs: string[] = [];
const handles: DatabaseHandle[] = [];

function open(): DatabaseHandle {
  const dir = mkdtempSync(join(tmpdir(), "usage-portal-interval-"));
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

describe("fetch interval options", () => {
  test("1 分は出さず、5 分から 120 分まで", () => {
    expect(FETCH_INTERVAL_OPTIONS_MINUTES).toEqual([5, 10, 30, 60, 120]);
    expect(DEFAULT_FETCH_INTERVAL_MINUTES).toBe(10);
    expect(fetchIntervalMs(10)).toBe(600_000);
  });

  test("一覧に無い値と provider を受け付けない", () => {
    for (const minutes of [5, 10, 30, 60, 120]) {
      expect(isFetchIntervalMinutes(minutes)).toBe(true);
    }

    for (const minutes of [0, 1, 2, 7, 15, 121, 60.5, "5", null, undefined]) {
      expect(isFetchIntervalMinutes(minutes)).toBe(false);
    }

    expect(isFetchIntervalProvider("codex")).toBe(true);
    expect(isFetchIntervalProvider("opencode-go")).toBe(true);
    expect(isFetchIntervalProvider("openai")).toBe(false);
    expect(isFetchIntervalProvider(null)).toBe(false);
  });
});

describe("createFetchIntervalStore", () => {
  test("保存値が無ければ既定値、保存後は保存値", () => {
    const handle = open();
    const store = createFetchIntervalStore({ db: handle, defaultMs: 600_000, log: () => {} });

    expect(store.list()).toEqual({ codex: 600_000, "opencode-go": 600_000 });

    store.set("opencode-go", 1_800_000);

    expect(store.get("opencode-go")).toBe(1_800_000);
    expect(store.get("codex")).toBe(600_000);
    expect(store.list()).toEqual({ codex: 600_000, "opencode-go": 1_800_000 });
  });
});
