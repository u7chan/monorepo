import assert from "node:assert/strict";

import test from "node:test";
import { isMiddleClick } from "../src/lib/fileTabs";

test("中クリックは button === 1 だけ", () => {
  assert.equal(isMiddleClick({ button: 1 }), true);
  for (const button of [0, 2, 3]) assert.equal(isMiddleClick({ button }), false);
});
