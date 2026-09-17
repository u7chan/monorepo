// ファイル画面の保存 schema。壊れた入力・上限・prototype 名・保存領域の例外を純関数と薄い境界で固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  createFilePreviewStore,
  decodeFilePreviewSnapshots,
  encodeFilePreviewSnapshots,
  FILE_SNAPSHOT_CWD_LIMIT,
  FILE_SNAPSHOT_DIR_LIMIT,
  FILE_SNAPSHOT_KEY,
  FILE_SNAPSHOT_MAX_BYTES,
  FILE_SNAPSHOT_VERSION,
  parseFilePreviewSnapshot,
  type FilePreviewSnapshot,
  type FilePreviewSnapshots,
  type SnapshotStorage,
} from "../src/lib/filePreviewState";
import type { PreviewMode, PreviewModes } from "../src/lib/fileTabs";

const snapshot = (overrides: Partial<FilePreviewSnapshot> = {}): FilePreviewSnapshot => ({
  paths: ["a.html", "b/c.txt"],
  active: "b/c.txt",
  modes: { "a.html": "preview", "b/c.txt": "source" },
  dirs: ["a"],
  ...overrides,
});

const raw = (value: unknown): string => JSON.stringify(value);
const body = (cwds: unknown, version: unknown = FILE_SNAPSHOT_VERSION): string => raw({ version, cwds });
const bytes = (text: string): number => new TextEncoder().encode(text).length;

class FakeStorage implements SnapshotStorage {
  value: string | null = null;
  failRead = false;
  failWrite = false;
  writes = 0;
  lastKey: string | null = null;

  getItem(key: string): string | null {
    this.lastKey = key;
    if (this.failRead) throw new Error("read failed");
    return this.value;
  }

  setItem(key: string, value: string): void {
    this.lastKey = key;
    if (this.failWrite) throw new Error("write failed");
    this.writes += 1;
    this.value = value;
  }
}

test("encode / decode は snapshot を往復する", () => {
  const snapshots: FilePreviewSnapshots = {
    "projects/app": snapshot(),
    ".": snapshot({ paths: [], active: null, modes: {}, dirs: [] }),
  };
  assert.deepEqual(decodeFilePreviewSnapshots(encodeFilePreviewSnapshots(snapshots)), snapshots);
});

test("prototype の名前も cwd とパスとして往復する", () => {
  const paths = ["__proto__", "constructor", "toString"];
  // プロトタイプの名前は computed key / Object.fromEntries で書く (リテラルの `__proto__:` はプロトタイプの設定になり、
  // `toString` は Object.prototype 側の型が優先されて文脈型が付かない)
  const modeEntries: [string, PreviewMode][] = [
    ["__proto__", "source"],
    ["toString", "preview"],
  ];
  const modes: PreviewModes = Object.fromEntries(modeEntries);
  const saved = snapshot({ paths, active: "constructor", modes, dirs: ["__proto__/child"] });
  // 保存値の cwd map も own property として扱う (継承プロパティを状態として拾わない)
  const encoded = encodeFilePreviewSnapshots(Object.fromEntries([["__proto__", saved]]));
  const decoded = decodeFilePreviewSnapshots(encoded);
  assert.equal(Object.hasOwn(decoded, "__proto__"), true);
  assert.deepEqual(decoded.__proto__, saved);
});

test("JSON 全体が壊れているときだけ全体を捨てる", () => {
  assert.deepEqual(decodeFilePreviewSnapshots(null), {});
  assert.deepEqual(decodeFilePreviewSnapshots(""), {});
  assert.deepEqual(decodeFilePreviewSnapshots("{oops"), {});
  assert.deepEqual(decodeFilePreviewSnapshots("[1,2]"), {});
  assert.deepEqual(decodeFilePreviewSnapshots(body({ "projects/app": snapshot() }, FILE_SNAPSHOT_VERSION + 1)), {});
  assert.deepEqual(decodeFilePreviewSnapshots(raw({ version: FILE_SNAPSHOT_VERSION })), {});
  assert.deepEqual(decodeFilePreviewSnapshots(raw({ version: FILE_SNAPSHOT_VERSION, cwds: "nope" })), {});
});

test("壊れた cwd だけを捨て、他の cwd は残す", () => {
  const decoded = decodeFilePreviewSnapshots(
    body({
      "projects/app": snapshot(),
      "projects/broken": { paths: ["a.txt", "a.txt"], active: null, modes: {}, dirs: [] },
      "projects/other": snapshot({ paths: ["x.txt"], active: "x.txt", modes: {}, dirs: [] }),
    }),
  );
  assert.deepEqual(Object.keys(decoded), ["projects/app", "projects/other"]);
});

test("形の合わない snapshot は 1 件ずつ捨てる", () => {
  const cases: [string, unknown][] = [
    ["record でない", "nope"],
    ["paths が無い", { active: null, modes: {}, dirs: [] }],
    ["paths に文字列以外が混ざる", { paths: ["a.txt", 1], active: null, modes: {}, dirs: [] }],
    ["paths が空文字を含む", { paths: ["a.txt", ""], active: null, modes: {}, dirs: [] }],
    ["paths が重複する", { paths: ["a.txt", "a.txt"], active: null, modes: {}, dirs: [] }],
    [
      "保存上限を超えるタブ数",
      { paths: Array.from({ length: 9 }, (_, i) => `${i}.txt`), active: null, modes: {}, dirs: [] },
    ],
    ["active が paths に無い", { paths: ["a.txt"], active: "b.txt", modes: {}, dirs: [] }],
    ["active が文字列でも null でもない", { paths: ["a.txt"], active: undefined, modes: {}, dirs: [] }],
    ["modes が enum に無い", { paths: ["a.txt"], active: null, modes: { "a.txt": "raw" }, dirs: [] }],
    ["modes のキーがタブに無い", { paths: ["a.txt"], active: null, modes: { "b.txt": "source" }, dirs: [] }],
    ["dirs が配列でない", { paths: [], active: null, modes: {}, dirs: "a" }],
    ["dirs が root を含む", { paths: [], active: null, modes: {}, dirs: ["."] }],
    ["dirs に空文字が混ざる", { paths: [], active: null, modes: {}, dirs: ["a", ""] }],
    ["dirs が重複する", { paths: [], active: null, modes: {}, dirs: ["a", "a"] }],
    ["dirs が絶対パス", { paths: [], active: null, modes: {}, dirs: ["/etc"] }],
    ["dirs が親を辿る", { paths: [], active: null, modes: {}, dirs: ["a/../b"] }],
    ["dirs が現在を指す", { paths: [], active: null, modes: {}, dirs: ["a/./b"] }],
    [
      "dirs が保存上限を超える",
      {
        paths: [],
        active: null,
        modes: {},
        dirs: Array.from({ length: FILE_SNAPSHOT_DIR_LIMIT + 1 }, (_, i) => `d${i}`),
      },
    ],
  ];
  for (const [name, value] of cases) {
    assert.equal(parseFilePreviewSnapshot(value), null, name);
  }
  // タブが無ければ active null と空の配列は通る
  assert.deepEqual(parseFilePreviewSnapshot({ paths: [], active: null, modes: {}, dirs: [] }), {
    paths: [],
    active: null,
    modes: {},
    dirs: [],
  });
});

test("store は他 cwd を消さずに merge し、1 件だけ消せる", () => {
  const storage = new FakeStorage();
  const store = createFilePreviewStore(storage);
  store.write("projects/a", snapshot());
  store.write("projects/b", snapshot({ paths: ["only-b.txt"], active: "only-b.txt", modes: {}, dirs: [] }));
  assert.deepEqual(store.read("projects/a"), snapshot());
  assert.deepEqual(store.read("projects/b")?.paths, ["only-b.txt"]);
  assert.equal(storage.lastKey, FILE_SNAPSHOT_KEY, "1 つのキーだけを使う");

  store.write("projects/a", null);
  assert.equal(store.read("projects/a"), null);
  assert.deepEqual(store.read("projects/b")?.paths, ["only-b.txt"]);
});

test("保存する内容が無い snapshot は cwd ごと消す", () => {
  const storage = new FakeStorage();
  const store = createFilePreviewStore(storage);
  store.write("projects/a", snapshot());
  store.write("projects/b", snapshot({ dirs: [] }));
  store.write("projects/a", { paths: [], active: null, modes: {}, dirs: [] });
  assert.deepEqual(decodeFilePreviewSnapshots(storage.value), { "projects/b": snapshot({ dirs: [] }) });
});

test("cwd は normalizeFileTreeRoot と同じ単位で扱う", () => {
  const storage = new FakeStorage();
  const store = createFilePreviewStore(storage);
  // ワークスペース root ("") と "." は同じ保存先
  store.write("", snapshot({ dirs: ["a"] }));
  assert.deepEqual(store.read(".")?.dirs, ["a"]);
  // 絶対パスも root へ畳む (取得 root と保存キーの単位を揃える)
  store.write("/home/u7/project", snapshot({ dirs: ["b"] }));
  assert.deepEqual(store.read(".")?.dirs, ["b"]);
});

test("保存領域が例外を投げても操作を止めず、メモリ側で同一セッションの復元を保つ", () => {
  const storage = new FakeStorage();
  storage.failRead = true;
  const store = createFilePreviewStore(storage);
  assert.equal(store.read("projects/a"), null);

  storage.failWrite = true;
  store.write("projects/a", snapshot());
  assert.deepEqual(store.read("projects/a"), snapshot(), "write 失敗後はメモリから返す");
  assert.equal(storage.value, null);

  // 復帰後も同じ store なら書ける (無限リトライはしないが、次の変更では試す)
  storage.failWrite = false;
  storage.failRead = false;
  store.write("projects/a", snapshot({ dirs: ["a", "b"] }));
  assert.deepEqual(store.read("projects/a")?.dirs, ["a", "b"]);
  assert.deepEqual(decodeFilePreviewSnapshots(storage.value)["projects/a"]?.dirs, ["a", "b"]);
});

test("保存先が無い環境でも read / write は落ちない", () => {
  const store = createFilePreviewStore(null);
  assert.equal(store.read("projects/a"), null);
  store.write("projects/a", snapshot());
  assert.deepEqual(store.read("projects/a"), snapshot(), "メモリ側は使える");
});

test("書き込み前の JSON が上限を超えるときは書かない", () => {
  const storage = new FakeStorage();
  const store = createFilePreviewStore(storage);
  const longPath = `${"x".repeat(FILE_SNAPSHOT_MAX_BYTES / 8)}.txt`;
  const huge = snapshot({
    paths: Array.from({ length: 8 }, (_, i) => `${i}-${longPath}`),
    active: null,
    modes: {},
    dirs: [],
  });
  store.write("projects/a", huge);
  assert.equal(storage.writes, 0);
  assert.equal(storage.value, null);
  assert.equal(bytes(encodeFilePreviewSnapshots({ "projects/a": huge })) > FILE_SNAPSHOT_MAX_BYTES, true);
  assert.deepEqual(store.read("projects/a"), huge, "メモリ側には残る");
});

test("cwd 数が上限を超えたら先に書かれた cwd から落とす", () => {
  const storage = new FakeStorage();
  const store = createFilePreviewStore(storage);
  for (let i = 0; i <= FILE_SNAPSHOT_CWD_LIMIT; i += 1) store.write(`projects/p${i}`, snapshot());
  const stored = decodeFilePreviewSnapshots(storage.value);
  assert.equal(Object.keys(stored).length, FILE_SNAPSHOT_CWD_LIMIT);
  assert.equal(Object.hasOwn(stored, "projects/p0"), false, "最も古い cwd を落とす");
  assert.equal(Object.hasOwn(stored, `projects/p${FILE_SNAPSHOT_CWD_LIMIT}`), true, "今回書いた cwd は残る");
});

test("保存値が変わらないときは書き込まない", () => {
  const storage = new FakeStorage();
  const store = createFilePreviewStore(storage);
  store.write("projects/a", snapshot());
  const writes = storage.writes;
  store.write("projects/a", snapshot());
  assert.equal(storage.writes, writes);
});

test("読み手が捨てる形は書かず、既存の保存値を維持する", () => {
  const storage = new FakeStorage();
  const store = createFilePreviewStore(storage);
  store.write("projects/a", snapshot());
  const stored = storage.value;
  const writes = storage.writes;

  // 展開が上限を超える書き込み。書いてしまうと decode が cwd ごと捨て、次の起動でタブもモードも失う
  const overDirs = snapshot({ dirs: Array.from({ length: FILE_SNAPSHOT_DIR_LIMIT + 1 }, (_, i) => `d${i}`) });
  store.write("projects/a", overDirs);
  assert.equal(storage.writes, writes, "上限を超える展開は書かない");
  assert.equal(storage.value, stored);
  assert.deepEqual(store.read("projects/a"), overDirs, "メモリ側は最新のまま (同一セッション内は復元できる)");

  // タブ上限・active の不整合・閉じたタブのモードも同じ (通常操作では作られないが、読み手の検証と食い違う値を書かない)
  const invalid: FilePreviewSnapshot[] = [
    snapshot({ paths: Array.from({ length: 9 }, (_, i) => `${i}.txt`), active: null, modes: {} }),
    snapshot({ paths: ["a.txt"], active: "b.txt", modes: {} }),
    snapshot({ paths: ["a.txt"], active: null, modes: { "b.txt": "source" } }),
  ];
  for (const value of invalid) {
    store.write("projects/a", value);
    assert.equal(storage.value, stored);
  }

  // 上限内に戻ればまた書ける (読み直して merge する経路は維持する)
  store.write("projects/a", snapshot({ dirs: ["a", "b"] }));
  assert.deepEqual(decodeFilePreviewSnapshots(storage.value)["projects/a"]?.dirs, ["a", "b"]);
});

test("__proto__ という cwd も own property として保存・復元する", () => {
  const storage = new FakeStorage();
  const store = createFilePreviewStore(storage);
  store.write("__proto__", snapshot({ dirs: ["child"] }));
  assert.deepEqual(store.read("__proto__")?.dirs, ["child"]);
  assert.deepEqual(decodeFilePreviewSnapshots(storage.value).__proto__?.dirs, ["child"]);
});
