import assert from "node:assert/strict";
import test from "node:test";
import { createRequestGate } from "../src/hooks/requestGate";

test("later requests prevent older responses from overwriting the list", async () => {
  const begin = createRequestGate();
  let resolveOld!: () => void;
  const pending = new Promise<void>((resolve) => { resolveOld = resolve; });
  const applied: string[] = [];
  const old = begin();
  const oldRequest = pending.then(() => { if (old()) applied.push("old"); });
  const latest = begin();
  if (latest()) applied.push("latest");
  resolveOld();
  await oldRequest;
  assert.deepEqual(applied, ["latest"]);
});

test("cleanup invalidates pending responses; a new setup can apply again", () => {
  const begin = createRequestGate();
  let active = true;
  const old = begin(() => active);
  assert.equal(old(), true);
  active = false;
  assert.equal(old(), false);
  const reconnected = begin();
  assert.equal(reconnected(), true);
  assert.equal(old(), false);
});
