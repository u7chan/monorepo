// session-store の純関数 / ライター。ファイルシステムを使う検証は一時ディレクトリで行う。

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SessionFileWriter,
  generateSessionId,
  parseSessionFile,
  prepareSessionStore,
  resolveSessionStoreDir,
  sessionJsonlPath,
  serializeSession,
  sessionHeaderOf,
  sessionWorkdirRel,
  type SessionEntryLike,
} from "../src/session-store";

const HEADER = { type: "session", version: 3, id: "a1b2c3d4e5", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/work" };

function messageEntry(id: string, parentId: string | null): SessionEntryLike {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", content: "hello" },
  };
}

function lines(entries: unknown[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
}

test("resolveSessionStoreDir rejects a store inside the workspace root", () => {
  assert.throws(
    () => resolveSessionStoreDir({ rootCwd: "/work", env: { PI_SESSION_STORE: "/work/store" } }),
    /外を指定/,
  );
  assert.throws(() => resolveSessionStoreDir({ rootCwd: "/work", env: { PI_SESSION_STORE: "/work" } }), /外を指定/);
  assert.equal(
    resolveSessionStoreDir({ rootCwd: "/work", env: { PI_SESSION_STORE: "/var/lib/pi-agent-gui" } }),
    "/var/lib/pi-agent-gui",
  );
  assert.match(resolveSessionStoreDir({ rootCwd: "/work", env: {} }), /pi-agent-gui\/sessions$/);
});

test("generateSessionId returns a short hex id that does not collide", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-store-"));
  try {
    await prepareSessionStore(dir);
    const seen = new Set<string>();
    for (let index = 0; index < 20; index += 1) {
      const id = generateSessionId(dir);
      assert.match(id, /^[0-9a-f]{10}$/);
      assert.equal(seen.has(id), false);
      seen.add(id);
    }
    assert.equal(sessionWorkdirRel("a1b2c3d4e5"), ".pi-agent-gui/sessions/a1b2c3d4e5");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseSessionFile accepts a valid file and reports the complete prefix", () => {
  const entries = [messageEntry("e1", null), messageEntry("e2", "e1")];
  const text = lines([HEADER, ...entries]);
  const parsed = parseSessionFile(text, HEADER.id);
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.completeBytes, Buffer.byteLength(text, "utf8"));
  assert.equal(parsed.needsSeparator, false);
});

test("parseSessionFile drops only a torn tail line", () => {
  const text = `${lines([HEADER, messageEntry("e1", null)])}{"type":"message","id":"e2"`;
  const parsed = parseSessionFile(text, HEADER.id);
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.needsSeparator, false);
});

test("parseSessionFile keeps a parseable tail without a newline and asks for a separator", () => {
  const text = lines([HEADER, messageEntry("e1", null)]).trimEnd();
  const parsed = parseSessionFile(text, HEADER.id);
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.needsSeparator, true);
});

test("parseSessionFile treats structural damage as damaged without touching the original", () => {
  const cases: Array<[string, unknown[]]> = [
    ["header の id 不一致", [{ ...HEADER, id: "ffffffffff" }, messageEntry("e1", null)]],
    ["未知 version", [{ ...HEADER, version: 99 }, messageEntry("e1", null)]],
    ["header なし", [messageEntry("e1", null)]],
    ["重複 id", [HEADER, messageEntry("e1", null), messageEntry("e1", "e1")]],
    ["自己参照", [HEADER, messageEntry("e1", "e1")]],
    ["前方参照", [HEADER, messageEntry("e1", "e2"), messageEntry("e2", "e1")]],
    ["未知 type", [HEADER, { type: "ghost", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z" }]],
    [
      "中間の壊れた行",
      // 手で連結するため文字列を直接組み立てるケースで使う
      null as unknown as unknown[],
    ],
  ];
  for (const [label, entries] of cases) {
    if (entries === null) continue;
    const parsed = parseSessionFile(lines(entries), HEADER.id);
    assert.equal(parsed.kind, "damaged", label);
  }
  const middle = lines([HEADER, messageEntry("e1", null)]) + "{broken\n" + lines([messageEntry("e2", "e1")]);
  assert.equal(parseSessionFile(middle, HEADER.id).kind, "damaged", "中間の壊れた行");
  assert.equal(parseSessionFile("", HEADER.id).kind, "empty", "空ファイルは empty");
});

test("SessionFileWriter rewrites, appends and repairs a torn tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-writer-"));
  try {
    await prepareSessionStore(dir);
    const id = "a1b2c3d4e5";
    const header = sessionHeaderOf({ id, createdAt: Date.parse("2026-01-01T00:00:00.000Z") }, "/work");
    const first = messageEntry("e1", null);
    const writer = new SessionFileWriter(dir, id);
    await writer.schedule(header, [first]);
    assert.equal(writer.error, undefined);

    const second = messageEntry("e2", "e1");
    await writer.schedule(header, [first, second]);
    const text = await readFile(sessionJsonlPath(id, dir), "utf8");
    assert.equal(text, serializeSession(header, [first, second]));

    // 途絶した末尾は次の書込みで捨てられ、entry が連結しない
    const torn = `${serializeSession(header, [first, second])}{"type":"message","id":"e3"`;
    await writeFile(sessionJsonlPath(id, dir), torn);
    const parsed = parseSessionFile(torn, id);
    assert.equal(parsed.kind, "ok");
    if (parsed.kind !== "ok") return;
    const resumed = new SessionFileWriter(dir, id, {
      completeBytes: parsed.completeBytes,
      entries: parsed.entries,
      needsSeparator: parsed.needsSeparator,
    });
    const third = messageEntry("e3", "e2");
    await resumed.schedule(header, [first, second, third]);
    const repaired = await readFile(sessionJsonlPath(id, dir), "utf8");
    assert.equal(repaired, serializeSession(header, [first, second, third]));
    assert.equal(parseSessionFile(repaired, id).kind, "ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SessionFileWriter keeps the original file when it cannot write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-writer-"));
  try {
    const id = "a1b2c3d4e5";
    const header = sessionHeaderOf({ id, createdAt: 1 }, "/work");
    // ディレクトリを作れない位置にファイルを置く → 書けないが例外は投げず、error に残す
    await writeFile(join(dir, "blocked"), "file\n");
    const writer = new SessionFileWriter(join(dir, "blocked"), id);
    await writer.schedule(header, [messageEntry("e1", null)]);
    assert.ok(writer.error, "書込み失敗が error に出る");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SessionFileWriter serializes overlapping schedules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-writer-"));
  try {
    await prepareSessionStore(dir);
    const id = "a1b2c3d4e5";
    const header = sessionHeaderOf({ id, createdAt: 1 }, "/work");
    const writer = new SessionFileWriter(dir, id);
    const first = messageEntry("e1", null);
    const second = messageEntry("e2", "e1");
    const third = messageEntry("e3", "e2");
    await Promise.all([
      writer.schedule(header, [first]),
      writer.schedule(header, [first, second]),
      writer.schedule(header, [first, second, third]),
    ]);
    assert.equal(writer.error, undefined);
    const text = await readFile(sessionJsonlPath(id, dir), "utf8");
    assert.equal(text, serializeSession(header, [first, second, third]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
