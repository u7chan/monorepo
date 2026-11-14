// ブラウザの待受ポートの割当を、実カーネルやソケットに依存せず固定する。
// 予約レンジはサンドボックスの Landlock の許可ポートと一致している必要があるため、
// レンジの値そのものと、枠ごとに重ならないことをここで縛る。

import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_PORT_RANGE_END, BROWSER_PORT_RANGE_START, MAX_CONCURRENT_CALLS } from "../src/browser/limits";
import { browserPortRangeCapacity, browserPortsForSlot } from "../src/browser/ports";

test("assigns three disjoint ports per slot inside the reserved range", () => {
  const seen = new Set<number>();
  for (let index = 0; index < MAX_CONCURRENT_CALLS; index += 1) {
    const ports = browserPortsForSlot(index);
    for (const port of [ports.proxy, ports.fixture, ports.closed]) {
      assert.ok(port >= BROWSER_PORT_RANGE_START, `${port} is below the range`);
      assert.ok(port <= BROWSER_PORT_RANGE_END, `${port} is above the range`);
      // 枠をまたいで同じポートを 2 つの呼び出しが使わないこと
      assert.equal(seen.has(port), false, `${port} is assigned twice`);
      seen.add(port);
    }
    // 閉じた検証用ポートを fixture が取り直さないよう、同じ呼び出しの中でも重ならない
    assert.equal(new Set([ports.proxy, ports.fixture, ports.closed]).size, 3);
  }
});

test("keeps the range large enough for the concurrency limit", () => {
  assert.ok(browserPortRangeCapacity() >= MAX_CONCURRENT_CALLS);
});

test("refuses a slot outside the range instead of using another port", () => {
  const last = browserPortRangeCapacity() - 1;
  assert.doesNotThrow(() => browserPortsForSlot(last));
  assert.throws(() => browserPortsForSlot(browserPortRangeCapacity()), /範囲/);
  assert.throws(() => browserPortsForSlot(-1), /不正/);
  assert.throws(() => browserPortsForSlot(1.5), /不正/);
});
