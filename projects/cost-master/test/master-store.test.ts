import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planJudgment } from "../src/server/master";
import { createMasterStore, type MasterStore } from "../src/server/master-store";

const BUNDLED = new URL("../src/server/data/", import.meta.url).pathname;
const dirs: string[] = [];
const logs: string[] = [];

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cost-master-"));
  dirs.push(dir);

  return dir;
}

function newStore(dir: string) {
  return createMasterStore({ dir, bundledDir: BUNDLED, log: (line) => logs.push(line) });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }

  logs.length = 0;
});

function modelsOf(store: MasterStore) {
  const state = store.state();

  if (!state.ok) {
    throw new Error("master unavailable");
  }

  return state.payload.models;
}

const ENABLED_HIDDEN = JSON.stringify({ models: [{ modelId: "krea/krea-2-large", enabled: false }] }, null, 2);

describe("ensureSeed", () => {
  test("volume が空なら image の初期値をコピーする", () => {
    const dir = newDir();
    const store = newStore(dir);

    store.ensureSeed();

    expect(readFileSync(join(dir, "prices.json"), "utf8")).toBe(readFileSync(join(BUNDLED, "prices.json"), "utf8"));
    expect(logs).toContain("マスタを image からコピーしました: enabled.json");
  });

  test("既にあるファイルは上書きしない", () => {
    const dir = newDir();
    writeFileSync(join(dir, "enabled.json"), ENABLED_HIDDEN);
    writeFileSync(join(dir, "prices.json"), readFileSync(join(BUNDLED, "prices.json")));
    const store = newStore(dir);

    store.ensureSeed();

    expect(readFileSync(join(dir, "enabled.json"), "utf8")).toBe(ENABLED_HIDDEN);
  });

  test("片方だけある volume にはコピーしない（消した判断を image で上書きしない）", () => {
    const dir = newDir();
    writeFileSync(join(dir, "enabled.json"), ENABLED_HIDDEN);
    const store = newStore(dir);

    store.ensureSeed();

    expect(() => readFileSync(join(dir, "prices.json"), "utf8")).toThrow();
    expect(logs).toContain("マスタが一部だけあります（enabled）。image からのコピーはしません");
    // コピーしないので、マスタは読めない（空の一覧を返さない）
    expect(store.state()).toEqual({ ok: false });
  });
});

describe("state", () => {
  test("確定したマスタを応答の形へ組み立てる", () => {
    const dir = newDir();
    writeFileSync(join(dir, "prices.json"), readFileSync(join(BUNDLED, "prices.json")));
    writeFileSync(join(dir, "enabled.json"), ENABLED_HIDDEN);
    const state = newStore(dir).state();

    expect(state.ok).toBe(true);
    expect(state.ok && state.payload.models.length).toBeGreaterThan(0);
    expect(
      state.ok && state.payload.models.every((model) => model.enabled === (model.modelId !== "krea/krea-2-large")),
    ).toBe(true);
  });

  test("ファイルが差し替わったら読み直す（再起動しない）", () => {
    const dir = newDir();
    writeFileSync(join(dir, "prices.json"), readFileSync(join(BUNDLED, "prices.json")));
    writeFileSync(join(dir, "enabled.json"), JSON.stringify({ models: [] }));
    const store = newStore(dir);

    expect(modelsOf(store).some((model) => !model.enabled)).toBe(false);

    writeFileSync(join(dir, "enabled.json"), ENABLED_HIDDEN);
    // mtime の粒度に依存させない。差し替えたことが分かる時刻を明示する
    const future = new Date(Date.now() + 5_000);
    utimesSync(join(dir, "enabled.json"), future, future);

    const hidden = modelsOf(store).filter((model) => !model.enabled);

    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.every((model) => model.modelId === "krea/krea-2-large")).toBe(true);
  });

  test("落とした行は起動ログに出す（黙って既定へ倒さない）", () => {
    const dir = newDir();
    writeFileSync(join(dir, "prices.json"), readFileSync(join(BUNDLED, "prices.json")));
    writeFileSync(join(dir, "enabled.json"), JSON.stringify({ models: [{ modelId: "a", enabled: "false" }] }));

    newStore(dir).state();

    expect(logs).toContain("マスタの行を落としました: a (enabled)");
  });

  test("知らない形の行しか無い prices.json は読めないとして返す（空の一覧にしない）", () => {
    const dir = newDir();
    const file = JSON.parse(readFileSync(join(BUNDLED, "prices.json"), "utf8")) as {
      models: { kind?: string }[];
    };
    writeFileSync(
      join(dir, "prices.json"),
      JSON.stringify({
        version: 3,
        fetchedAt: 1_794_600_000_000,
        models: file.models.map(({ kind: _kind, ...row }) => row),
      }),
    );
    writeFileSync(join(dir, "enabled.json"), JSON.stringify({ models: [] }));

    expect(newStore(dir).state()).toEqual({ ok: false });
  });

  test("壊れたファイルは読めないとして返す（空の一覧にしない）", () => {
    const dir = newDir();
    writeFileSync(join(dir, "prices.json"), "{ not json");
    writeFileSync(join(dir, "enabled.json"), "{}");

    expect(newStore(dir).state()).toEqual({ ok: false });
  });
});

describe("replace", () => {
  test("検証してから置き換え、直前の内容を .bak に残す", () => {
    const dir = newDir();
    writeFileSync(join(dir, "prices.json"), readFileSync(join(BUNDLED, "prices.json")));
    writeFileSync(join(dir, "enabled.json"), JSON.stringify({ models: [] }));
    const store = newStore(dir);

    const result = store.replace("enabled", ENABLED_HIDDEN);

    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "enabled.json"), "utf8")).toBe(`${ENABLED_HIDDEN}\n`);
    expect(readFileSync(join(dir, "enabled.json.bak"), "utf8")).toBe(JSON.stringify({ models: [] }));
    expect(result.ok && result.state.ok && result.state.payload.models.some((model) => !model.enabled)).toBe(true);
  });

  test("JSON として読めない入力を拒否し、ファイルを変えない", () => {
    const dir = newDir();
    writeFileSync(join(dir, "enabled.json"), JSON.stringify({ models: [] }));
    const store = newStore(dir);

    expect(store.replace("enabled", "{ not json")).toEqual({ ok: false, reason: "json" });
    expect(readFileSync(join(dir, "enabled.json"), "utf8")).toBe(JSON.stringify({ models: [] }));
  });

  test("同じモデルの重複した判断も拒否する（黙って 1 行に畳まない）", () => {
    const dir = newDir();
    writeFileSync(join(dir, "prices.json"), readFileSync(join(BUNDLED, "prices.json")));
    writeFileSync(join(dir, "enabled.json"), JSON.stringify({ models: [] }));
    const store = newStore(dir);

    const duplicated = JSON.stringify({
      models: [
        { modelId: "a", enabled: false, note: "first" },
        { modelId: "a", enabled: false, note: "second" },
      ],
    });

    expect(store.replace("enabled", duplicated)).toEqual({ ok: false, reason: "rows" });
  });

  test("1 行でも不正な判断は全体を拒否する（起動時の読み込みと違って黙って落とさない）", () => {
    const dir = newDir();
    writeFileSync(join(dir, "enabled.json"), JSON.stringify({ models: [] }));
    const store = newStore(dir);

    const conflict = JSON.stringify({
      models: [
        { modelId: "a", enabled: false },
        { modelId: "a", enabled: true },
      ],
    });

    expect(store.replace("enabled", conflict)).toEqual({ ok: false, reason: "rows" });
  });

  test("片方だけ差し替えて全体が読めなくなるなら拒否する（反映したのに 503 を作らない）", () => {
    const dir = newDir();
    const store = newStore(dir);

    const input = JSON.stringify({ version: 1, fetchedAt: 1_794_600_000_000, models: [] });

    expect(store.replace("prices", input)).toEqual({ ok: false, reason: "master" });
  });

  test("価格は出力側以外の行を含むと拒否する", () => {
    const dir = newDir();
    const store = newStore(dir);

    const input = JSON.stringify({
      version: 1,
      fetchedAt: 1_794_600_000_000,
      models: [{ modelId: "a", kind: "image", billable: "input_image", unit: "image", variant: "", costUsd: 1 }],
    });

    expect(store.replace("prices", input)).toEqual({ ok: false, reason: "rows" });
  });

  test("正しい価格はそのまま置き換える", () => {
    const dir = newDir();
    writeFileSync(join(dir, "enabled.json"), JSON.stringify({ models: [] }));
    const store = newStore(dir);

    const input = JSON.stringify({
      version: 7,
      fetchedAt: 1_794_600_000_000,
      models: [{ modelId: "a", kind: "image", billable: "output_image", unit: "image", variant: "", costUsd: 0.5 }],
    });
    const result = store.replace("prices", input);

    expect(result.ok && result.state.ok && result.state.payload.version).toBe(7);
    expect(store.raw("prices")).toBe(`${input}\n`);
  });
});

describe("画面からの判断の反映", () => {
  test("1 行を足し、直前のファイルを .bak に残す", () => {
    const dir = newDir();
    writeFileSync(join(dir, "prices.json"), readFileSync(join(BUNDLED, "prices.json")));
    writeFileSync(join(dir, "enabled.json"), JSON.stringify({ models: [] }));
    const store = newStore(dir);
    const before = readFileSync(join(dir, "enabled.json"), "utf8");
    const plan = planJudgment(JSON.parse(before), "krea/krea-2-large", false);

    expect(plan?.changed).toBe(true);

    const result = store.replace("enabled", plan?.changed ? plan.text : "");

    expect(result.ok).toBe(true);
    expect(modelsOf(store).find((model) => model.modelId === "krea/krea-2-large")?.enabled).toBe(false);
    expect(readFileSync(join(dir, "enabled.json.bak"), "utf8")).toBe(before);
  });

  test("不正な行を含む置き換えは拒否し、ファイルを変えない", () => {
    const dir = newDir();
    writeFileSync(join(dir, "enabled.json"), JSON.stringify({ models: [] }));
    const store = newStore(dir);

    expect(store.replace("enabled", JSON.stringify({ models: [{ modelId: "a" }] }))).toEqual({
      ok: false,
      reason: "rows",
    });
    expect(readFileSync(join(dir, "enabled.json"), "utf8")).toBe(JSON.stringify({ models: [] }));
  });
});
