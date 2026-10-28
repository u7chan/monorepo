// ファイルツリーの再読み込みと進行中の取得の競合。取得中の要求を保留し、最後の取得後に 1 回だけ反映する。

import assert from "node:assert/strict";
import test from "node:test";
import { requestFileTreeReload, settleFileTreeRequest, type FileTreeReloadGate } from "../src/lib/fileTreeReload";

test("requestFileTreeReload: 取得中でなければ即時、あれば保留する", () => {
  assert.deepEqual(requestFileTreeReload({ pending: false }, 0), {
    gate: { pending: false },
    applyNow: true,
  });
  assert.deepEqual(requestFileTreeReload({ pending: false }, 2), {
    gate: { pending: true },
    applyNow: false,
  });
  // 保留中にさらに要求が来ても、反映は 1 回にまとめる
  assert.deepEqual(requestFileTreeReload({ pending: true }, 1), {
    gate: { pending: true },
    applyNow: false,
  });
});

test("settleFileTreeRequest: 最後の取得が終わるまで保留し、終わったら 1 回だけ反映する", () => {
  const pending: FileTreeReloadGate = { pending: true };
  assert.deepEqual(settleFileTreeRequest(pending, 1), { gate: pending, applyNow: false });
  assert.deepEqual(settleFileTreeRequest(pending, 0), {
    gate: { pending: false },
    applyNow: true,
  });
  // 保留が無いときの決着では何もしない (通常の取得完了で再読み込みを撃たない)
  assert.deepEqual(settleFileTreeRequest({ pending: false }, 0), {
    gate: { pending: false },
    applyNow: false,
  });
});
