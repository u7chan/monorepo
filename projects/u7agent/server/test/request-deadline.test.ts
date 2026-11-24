import assert from "node:assert/strict";
import test from "node:test";
import { startRequestDeadline } from "../src/request-deadline";

test("a request deadline starts when created and sets timedOut before notifying listeners", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const deadline = startRequestDeadline(20);
  const onAbort = t.mock.fn(() => {
    assert.equal(deadline.timedOut, true);
    assert.equal(deadline.aborted, false);
  });
  deadline.signal.addEventListener("abort", onAbort);
  t.mock.timers.tick(19);
  assert.equal(deadline.signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(deadline.signal.aborted, true);
  assert.equal(onAbort.mock.callCount(), 1);
  deadline.clear();
});

test("an already aborted user signal aborts the request immediately without marking it timed out", () => {
  const reason = new Error("user canceled");
  const deadline = startRequestDeadline(20, AbortSignal.abort(reason));
  try {
    assert.equal(deadline.signal.aborted, true);
    assert.equal(deadline.aborted, true);
    assert.equal(deadline.timedOut, false);
    assert.equal(deadline.signal.reason.name, "AbortError");
    assert.notEqual(deadline.signal.reason, reason);
  } finally {
    deadline.clear();
  }
});

test("user cancellation and expiration are separate flags", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const user = new AbortController();
  const deadline = startRequestDeadline(20, user.signal);
  user.abort();
  assert.equal(deadline.signal.aborted, true);
  assert.equal(deadline.aborted, true);
  assert.equal(deadline.timedOut, false);
  t.mock.timers.tick(20);
  assert.equal(deadline.aborted, true);
  assert.equal(deadline.timedOut, true);
  deadline.clear();
});

test("clearing its deadline prevents both timer expiry and later abort forwarding", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const user = new AbortController();
  const deadline = startRequestDeadline(20, user.signal);
  deadline.clear();
  user.abort();
  t.mock.timers.tick(20);
  assert.equal(deadline.signal.aborted, false);
  assert.equal(deadline.timedOut, false);
});
