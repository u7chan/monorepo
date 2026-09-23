// session-store の純関数 / ライター。ファイルシステムを使う検証は一時ディレクトリで行う。

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SessionFileWriter,
  generateSessionId,
  parseSessionFile,
  prepareSessionStore,
  resolveSessionStoreDir,
  sessionDirPath,
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
    message: { role: "user", content: "hello", timestamp: 1 },
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
    resolveSessionStoreDir({ rootCwd: "/work", env: { PI_SESSION_STORE: "/var/lib/u7agent" } }),
    "/var/lib/u7agent",
  );
  assert.match(resolveSessionStoreDir({ rootCwd: "/work", env: {} }), /u7agent\/sessions$/);
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
    assert.equal(sessionWorkdirRel("a1b2c3d4e5"), ".u7agent/sessions/a1b2c3d4e5");
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

test("parseSessionFile accepts content parts with the SDK shapes", () => {
  const entry = {
    type: "message",
    id: "e1",
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "assistant",
      timestamp: 1,
      content: [
        { type: "text", text: "こんにちは" },
        { type: "thinking", thinking: "考える" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
      ],
    },
  };
  assert.equal(parseSessionFile(lines([HEADER, entry]), HEADER.id).kind, "ok");
});

test("parseSessionFile rejects message entries missing content or timestamp", () => {
  const base = { type: "message", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z" };
  const cases: Array<[string, unknown]> = [
    ["timestamp 欠落", { ...base, message: { role: "user" } }],
    ["content 欠落", { ...base, message: { role: "user", timestamp: 1 } }],
    ["message.timestamp 欠落", { ...base, message: { role: "assistant", content: "x" } }],
    ["未知の role", { ...base, message: { role: "ghost", content: "x", timestamp: 1 } }],
    ["content part が null", { ...base, message: { role: "assistant", content: [null], timestamp: 1 } }],
    ["text part の text 欠落", { ...base, message: { role: "assistant", content: [{ type: "text" }], timestamp: 1 } }],
    [
      "toolCall part の name 欠落",
      {
        ...base,
        message: { role: "assistant", content: [{ type: "toolCall", id: "t1", arguments: {} }], timestamp: 1 },
      },
    ],
  ];
  for (const [label, entry] of cases) {
    assert.equal(parseSessionFile(lines([HEADER, entry]), HEADER.id).kind, "damaged", label);
  }
});

// SDK 0.87 が増やした entry。拒むとリトライ (context_edit) や cache warming (usage) の後に 409 で開けなくなる
test("parseSessionFile accepts the entry types SDK 0.87 appends", () => {
  const entries = [
    messageEntry("e1", null),
    {
      type: "context_edit",
      id: "e2",
      parentId: "e1",
      timestamp: "2026-01-01T00:00:02.000Z",
      targetId: "e1",
      replacement: null,
    },
    {
      type: "context_edit",
      id: "e3",
      parentId: "e2",
      timestamp: "2026-01-01T00:00:03.000Z",
      targetId: "e1",
      replacement: { content: [{ type: "text", text: "置換後の本文" }] },
    },
    {
      type: "usage",
      id: "e4",
      parentId: "e3",
      timestamp: "2026-01-01T00:00:04.000Z",
      kind: "cache_warm",
      provider: "openai",
      model: "gpt-6-luna",
      usage: { input: 1, output: 0, cacheRead: 9, cacheWrite: 0 },
    },
  ];
  const parsed = parseSessionFile(lines([HEADER, ...entries]), HEADER.id);
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;
  assert.equal(parsed.entries.length, entries.length);
});

test("parseSessionFile rejects malformed context_edit / usage entries", () => {
  const base = { id: "e2", parentId: "e1", timestamp: "2026-01-01T00:00:02.000Z" };
  const cases: Array<[string, unknown]> = [
    ["context_edit の targetId 欠落", { ...base, type: "context_edit", replacement: null }],
    ["context_edit の replacement が数値", { ...base, type: "context_edit", targetId: "e1", replacement: 1 }],
    [
      "context_edit の replacement.content が不正",
      { ...base, type: "context_edit", targetId: "e1", replacement: { content: [{ type: "text" }] } },
    ],
    ["usage の kind 欠落", { ...base, type: "usage", provider: "openai", model: "m", usage: {} }],
    ["usage の usage 欠落", { ...base, type: "usage", kind: "cache_warm", provider: "openai", model: "m" }],
  ];
  for (const [label, entry] of cases) {
    assert.equal(parseSessionFile(lines([HEADER, messageEntry("e1", null), entry]), HEADER.id).kind, "damaged", label);
  }
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

test("SessionFileWriter rolls back a partial write and retries from the committed position", async () => {
  const { writeSync } = await import("node:fs");
  const dir = await mkdtemp(join(tmpdir(), "session-writer-"));
  try {
    await prepareSessionStore(dir);
    const id = "a1b2c3d4e5";
    const header = sessionHeaderOf({ id, createdAt: 1 }, "/work");
    const first = messageEntry("e1", null);
    const second = messageEntry("e2", "e1");
    // 追記の途中で ENOSPC にするには、先に header + e1 を持つファイルを作る
    await new SessionFileWriter(dir, id).schedule(header, [first]);
    const persisted = parseSessionFile(await readFile(sessionJsonlPath(id, dir), "utf8"), id);
    assert.equal(persisted.kind, "ok");
    if (persisted.kind !== "ok") return;

    // 1 回目の追記だけ途中まで書いて ENOSPC にし、再試行では成功させる
    let calls = 0;
    const writer = new SessionFileWriter(
      dir,
      id,
      { completeBytes: persisted.completeBytes, entries: persisted.entries },
      (fd, buffer, offset, length, position) => {
        calls += 1;
        if (calls === 1) {
          const half = Math.floor(length / 2);
          if (half > 0) writeSync(fd, buffer, offset, half, position);
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        }
        return writeSync(fd, buffer, offset, length, position);
      },
    );
    await writer.schedule(header, [first, second]);
    assert.equal(writer.error, undefined);
    assert.ok(calls > 1, "再試行される");
    const text = await readFile(sessionJsonlPath(id, dir), "utf8");
    // 部分書込みが残らず、entry が重複・連結しない
    assert.equal(text, serializeSession(header, [first, second]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SessionFileWriter refuses a symlinked session.jsonl and keeps the target", async () => {
  const { symlinkSync, writeFileSync } = await import("node:fs");
  const dir = await mkdtemp(join(tmpdir(), "session-writer-"));
  try {
    await prepareSessionStore(dir);
    const id = "a1b2c3d4e5";
    await mkdir(sessionDirPath(dir, id), { recursive: true });
    const path = sessionJsonlPath(id, dir);
    const target = join(dir, "victim.jsonl");
    writeFileSync(target, "victim\n");
    symlinkSync(target, path);
    const writer = new SessionFileWriter(dir, id);
    await writer.schedule(sessionHeaderOf({ id, createdAt: 1 }, "/work"), [messageEntry("e1", null)]);
    assert.match(writer.error ?? "", /symlink/);
    assert.equal(await readFile(target, "utf8"), "victim\n", "リンク先を書き換えない");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SessionFileWriter bounds retries and preserves the committed prefix on persistent ENOSPC", async () => {
  const { writeSync } = await import("node:fs");
  const dir = await mkdtemp(join(tmpdir(), "session-writer-"));
  try {
    await prepareSessionStore(dir);
    const id = "a1b2c3d4e5";
    const header = sessionHeaderOf({ id, createdAt: 1 }, "/work");
    const first = messageEntry("e1", null);
    await new SessionFileWriter(dir, id).schedule(header, [first]);
    const persisted = parseSessionFile(await readFile(sessionJsonlPath(id, dir), "utf8"), id);
    assert.equal(persisted.kind, "ok");
    if (persisted.kind !== "ok") return;
    const before = await readFile(sessionJsonlPath(id, dir), "utf8");

    // 何度試しても ENOSPC。無限ループせず error を残し、確定位置まで巻き戻す
    const writer = new SessionFileWriter(
      dir,
      id,
      { completeBytes: persisted.completeBytes, entries: persisted.entries },
      (fd, buffer, offset, length, position) => {
        const half = Math.floor(length / 2);
        if (half > 0) writeSync(fd, buffer, offset, half, position);
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      },
    );
    await writer.schedule(header, [first, messageEntry("e2", "e1")]);
    assert.match(writer.error ?? "", /再試行|復旧/);
    assert.equal(await readFile(sessionJsonlPath(id, dir), "utf8"), before, "確定位置まで戻る");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SessionFileWriter truncates a torn tail before appending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-writer-"));
  try {
    await prepareSessionStore(dir);
    const id = "a1b2c3d4e5";
    await mkdir(sessionDirPath(dir, id), { recursive: true });
    const header = sessionHeaderOf({ id, createdAt: 1 }, "/work");
    const first = messageEntry("e1", null);
    // 次の追記より長い途絶末尾を残す
    const torn = serializeSession(header, [first]) + "x".repeat(4096);
    await writeFile(sessionJsonlPath(id, dir), torn);
    const parsed = parseSessionFile(torn, id);
    assert.equal(parsed.kind, "ok");
    if (parsed.kind !== "ok") return;
    const writer = new SessionFileWriter(dir, id, {
      completeBytes: parsed.completeBytes,
      entries: parsed.entries,
      needsSeparator: parsed.needsSeparator,
    });
    const second = messageEntry("e2", "e1");
    await writer.schedule(header, [first, second]);
    assert.equal(writer.error, undefined);
    assert.equal(await readFile(sessionJsonlPath(id, dir), "utf8"), serializeSession(header, [first, second]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseSessionFile rejects blank lines without changing the file", () => {
  const text = lines([HEADER, messageEntry("e1", null)]) + "\n";
  assert.equal(parseSessionFile(text, HEADER.id).kind, "damaged");
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
