import assert from "node:assert/strict";
import test from "node:test";
import { messageFor } from "../src/errors";

test("例外の文言は Error の名前や stack を添えず、改行は変えない", () => {
  assert.equal(messageFor(new TypeError("first\nsecond")), "first\nsecond");
  assert.equal(messageFor(new Error()), "");
});

test("Error 以外の値は String で変換する", () => {
  assert.equal(messageFor("failure"), "failure");
  assert.equal(messageFor(42), "42");
  assert.equal(messageFor(null), "null");
});
