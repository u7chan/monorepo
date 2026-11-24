// 端末設定の store の共通の境界 (client/src/lib/deviceSettingsStore.ts)。保存先の解決・メモリの控え・
// 書き込みの正規化を固定する。キーと parse / serialize は各 module のテストが持つ。
import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeviceSettingsStore,
  type DeviceSettingsStorage,
  type DeviceSettingsStoreOptions,
} from "../src/lib/deviceSettingsStore";

/** 数値 1 つ分の保存形式。各 module の parse / serialize の代わり */
function numberOptions(
  overrides: Partial<DeviceSettingsStoreOptions<number | null>> = {},
): DeviceSettingsStoreOptions<number | null> {
  return {
    key: "sample-key",
    parse: (raw: string | null): number | null => (raw === null ? null : Number(raw)),
    serialize: (value: number | null): string | null => (value === null ? null : String(value)),
    fallback: (): number | null => null,
    ...overrides,
  };
}

function fakeStorage(
  data: Map<string, string>,
): DeviceSettingsStorage & { reads: number; writes: number; removals: number } {
  return {
    reads: 0,
    writes: 0,
    removals: 0,
    getItem(key) {
      this.reads += 1;
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      this.writes += 1;
      data.set(key, value);
    },
    removeItem(key) {
      this.removals += 1;
      data.delete(key);
    },
  };
}

test("保存先を省いた store は、呼び出しのたびに window.localStorage を引き直す", () => {
  // What: 保存先を持たない環境で作った store (アプリの既定の store) が、後から現れた保存先を使うこと
  const data = new Map<string, string>([["sample-key", "7"]]);
  const globals = globalThis as { window?: unknown };
  const previous = globals.window;
  try {
    globals.window = undefined;
    const store = createDeviceSettingsStore<number | null>(undefined, numberOptions());
    assert.equal(store.read(), null, "保存先が無いのに保存値がある扱いになっている");

    globals.window = { localStorage: fakeStorage(data) };
    assert.equal(store.read(), 7);
    store.write(9);
    assert.equal(data.get("sample-key"), "9");
  } finally {
    globals.window = previous;
  }
});

test("読み取りは 1 度だけ保存値を見て、失敗したときだけ次の read で試し直す", () => {
  // What: メモリの控えが正になること、読み取りの失敗を控えないこと (復旧した保存先を次の read で拾う)
  const data = new Map<string, string>([["sample-key", "5"]]);
  const storage = fakeStorage(data);
  const store = createDeviceSettingsStore<number | null>(storage, numberOptions());
  assert.equal(store.read(), 5);
  assert.equal(store.read(), 5);
  assert.equal(storage.reads, 1);

  let reads = 0;
  const failing = createDeviceSettingsStore<number | null>(
    {
      getItem: () => {
        reads += 1;
        throw new Error("denied");
      },
      setItem: () => {},
    },
    numberOptions(),
  );
  assert.equal(failing.read(), null);
  assert.equal(failing.read(), null);
  assert.equal(reads, 2, "失敗した read を控えて再試行しなくなっている");

  // 書き込みは保存できなくてもメモリ側が正になり、読み取りの失敗を覆い隠さない
  failing.write(3);
  assert.equal(failing.read(), 3);
});

test("serialize が null を返す値はキーごと消し、removeItem を持たない保存先でも落ちない", () => {
  // What: 「未設定へ戻す」の扱いと、保存を消さない store が使う最小の保存先
  const data = new Map<string, string>([["sample-key", "1"]]);
  const storage = fakeStorage(data);
  const store = createDeviceSettingsStore<number | null>(storage, numberOptions());
  store.write(null);
  assert.equal(data.has("sample-key"), false);
  assert.equal(storage.removals, 1);

  const narrow = createDeviceSettingsStore<number | null>({ getItem: () => null, setItem: () => {} }, numberOptions());
  narrow.write(null);
  assert.equal(narrow.read(), null);
});

test("normalize はメモリへ控える前と、保存する前に通す", () => {
  // What: 読み手 (decode) が捨てる形を保存せず、同じセッションの読み手にも正規化した値だけを返すこと
  const writes: string[] = [];
  const store = createDeviceSettingsStore<number[]>(
    {
      getItem: () => null,
      setItem: (_key, value) => {
        writes.push(value);
      },
    },
    {
      key: "sample-key",
      parse: (): number[] => [],
      serialize: (values) => (values.length === 0 ? null : values.join(",")),
      normalize: (values) => [...new Set(values)],
      fallback: () => [],
    },
  );
  store.write([1, 1, 2]);
  assert.deepEqual(store.read(), [1, 2]);
  assert.deepEqual(writes, ["1,2"]);
});
