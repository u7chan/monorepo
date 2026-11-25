import assert from "node:assert/strict";
import test from "node:test";
import { declaredBodyTooLarge, readBodyBytes, readBodyText, readCappedBody } from "../src/bounded-body";

function readerOf(...chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }).getReader();
}

test("the declared limit only rejects finite values above the cap", () => {
  assert.equal(declaredBodyTooLarge(5, 4), true);
  assert.equal(declaredBodyTooLarge(4, 4), false);
  assert.equal(declaredBodyTooLarge(NaN, 4), false);
  assert.equal(declaredBodyTooLarge(Infinity, 4), false);
});

test("bounded byte reads accept the exact limit and return empty bytes without a body", async () => {
  const bytes = Uint8Array.of(0, 128, 255);
  assert.deepEqual(await readBodyBytes(readerOf(bytes.subarray(0, 1), bytes.subarray(1)), 3), bytes);
  assert.deepEqual(await readBodyBytes(undefined, 0), new Uint8Array());
});

test("bounded text decodes split UTF-8, flushes a trailing partial sequence, and limits bytes rather than characters", async () => {
  const encoded = new TextEncoder().encode("あい");
  const splitReader = () => readerOf(encoded.subarray(0, 2), encoded.subarray(2, 4));
  assert.equal(await readBodyText(splitReader(), 4), "あ\ufffd");
  assert.equal(await readBodyText(splitReader(), 3), undefined);
  assert.equal(await readBodyText(undefined, 0), "");
});

test("overflow normally waits for cancellation and ignores a cancellation failure", async () => {
  let markCancelStarted!: () => void;
  const cancelStarted = new Promise<void>((resolve) => {
    markCancelStarted = resolve;
  });
  let failCancel!: (error: Error) => void;
  const cancellation = new Promise<void>((_resolve, reject) => {
    failCancel = reject;
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.of(1, 2));
    },
    cancel() {
      markCancelStarted();
      return cancellation;
    },
  });
  let settled = false;
  const result = readBodyBytes(body.getReader(), 1).finally(() => {
    settled = true;
  });
  await cancelStarted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  failCancel(new Error("cancel failed"));
  assert.equal(await result, undefined);
});

test("overflow can finish without waiting for the other branch of a tee", async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.of(1, 2));
    },
  });
  const [bounded, other] = source.tee();
  try {
    const result = readBodyText(bounded.getReader(), 1, { cancelOnLimit: "background" });
    const nextTurn = new Promise<string>((resolve) => setImmediate(() => resolve("still waiting")));
    assert.equal(await Promise.race([result, nextTurn]), undefined);
  } finally {
    await other.cancel();
  }
});

test("only readers opted into error cleanup are canceled, and the original read error is rethrown", async (t) => {
  const error = new Error("read failed");
  for (const cancelOnReadError of [false, true]) {
    const reader = new ReadableStream<Uint8Array>({ start: (controller) => controller.error(error) }).getReader();
    const cancel = t.mock.method(reader, "cancel");
    await assert.rejects(readBodyText(reader, 1, { cancelOnReadError }), (thrown) => thrown === error);
    assert.equal(cancel.mock.callCount(), cancelOnReadError ? 1 : 0);
  }
});

test("capped image responses keep their existing numeric Content-Length interpretation and byte fallback", async () => {
  assert.equal(await readCappedBody(new Response("a", { headers: { "Content-Length": "2" } }), 1), undefined);
  assert.equal(await readCappedBody(new Response("a", { headers: { "Content-Length": "2x" } }), 1), "a");
  assert.equal(await readCappedBody(new Response("ab", { headers: { "Content-Length": "1" } }), 1), undefined);
});
