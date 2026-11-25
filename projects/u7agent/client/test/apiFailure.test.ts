// 失敗の写像 (ensureOk / read) の契約。JSON を読む経路と、204 / text / blob の経路で、
// status・文言・分類が変わらないことを固定する。
import assert from "node:assert/strict";
import test from "node:test";

globalThis.location ??= { origin: "http://localhost" } as Location;
const { ApiError, ensureOk, isNotStoredError, read } = await import("../src/api/http");
const { deleteFileSkill } = await import("../src/api/catalog");
const { getHealth, getRuntimeServeStatus } = await import("../src/api/runtime");

function caughtBy(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (reason: unknown) => reason,
  );
}

test("read は成功の本文を返し、失敗は本文の error と status を ApiError に写す", async () => {
  assert.deepEqual(await read<{ ok: boolean }>(Promise.resolve(Response.json({ ok: true }))), { ok: true });

  const failure = await caughtBy(read(Promise.resolve(Response.json({ error: "見つかりません" }, { status: 404 }))));
  assert.ok(failure instanceof ApiError);
  assert.equal(failure.message, "見つかりません");
  assert.equal(failure.status, 404);
  assert.equal(failure.state, undefined);
});

test("失敗の本文が JSON でなくても status を保ち、文言は HTTP <status> にする", async () => {
  for (const body of [null, "upstream timeout"]) {
    const failure = await caughtBy(read(Promise.resolve(new Response(body, { status: 502 }))));
    assert.ok(failure instanceof ApiError);
    assert.equal(failure.message, "HTTP 502");
    assert.equal(failure.status, 502);
  }
});

test("失敗の本文の state と code は ApiError の分類に残す", async () => {
  const failure = await caughtBy(
    read(
      Promise.resolve(
        Response.json({ error: "保存できません", state: "not_stored", code: "disk_shortage" }, { status: 503 }),
      ),
    ),
  );
  assert.ok(failure instanceof ApiError);
  assert.equal(isNotStoredError(failure), true);
  assert.equal(failure.code, "disk_shortage");
});

test("ensureOk は 204 / text / blob の本文を読まず、成功の応答をそのまま返す", async () => {
  const noContent = new Response(null, { status: 204 });
  assert.equal(await ensureOk(Promise.resolve(noContent)), noContent);

  const text = await ensureOk(Promise.resolve(new Response("v=0\r\n"))).then((res) => res.text());
  assert.equal(text, "v=0\r\n");

  // BOM と不正 UTF-8 を含むバイト列 (text() を通すと置換される)。blob の経路はそのまま返す
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x22, 0xff, 0x22, 0x7d]);
  const blob = await ensureOk(Promise.resolve(new Response(bytes))).then((res) => res.blob());
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
});

test("本文を読まない 204 の経路も、失敗は本文の理由と status を保つ", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "スキルの版が一致しません" }, { status: 409 }));
  const failure = await caughtBy(deleteFileSkill(".agents/skills/alpha", "old-tree-version"));
  assert.ok(failure instanceof ApiError);
  assert.equal(failure.message, "スキルの版が一致しません");
  assert.equal(failure.status, 409);
});

test("通信断は ApiError に写さず、そのまま呼び出し側へ伝える", async (t) => {
  const network = new TypeError("fetch failed");
  t.mock.method(globalThis, "fetch", async () => {
    throw network;
  });
  assert.equal(await caughtBy(getHealth()), network);
});

test("中断も ApiError に写さず、AbortError のまま呼び出し側へ伝える", async (t) => {
  const controller = new AbortController();
  const abort = new DOMException("The operation was aborted.", "AbortError");
  t.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.signal, controller.signal);
    throw abort;
  });
  const failure = await caughtBy(getRuntimeServeStatus(controller.signal));
  assert.equal(failure, abort);
  assert.ok(failure instanceof Error);
  assert.equal(failure.name, "AbortError");
});
