// CLI の引数 (server/src/browser/args.ts) と資源上限の既定を検証する。
// Phase 1 は --self-test だけを受け付け、未対応の引数は実行せずに落とす (資源上限はここが唯一の決定点)。

import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, USAGE } from "../src/browser/args";
import { BROWSER_ARGUMENTS } from "../src/browser/policy";
import { CALL_DEADLINE_MS, MAX_IMAGE_BYTES, MAX_OUTPUTS, parseDeadlineMs, VIEWPORT } from "../src/browser/limits";

test("--self-test は既定の期限で実行し、--deadline-ms で上書きできる", () => {
  assert.deepEqual(parseArgs(["--self-test"]), { selfTest: true, deadlineMs: CALL_DEADLINE_MS });
  assert.deepEqual(parseArgs(["--self-test", "--deadline-ms", "1500"]), { selfTest: true, deadlineMs: 1500 });
  assert.equal(CALL_DEADLINE_MS, 120_000);
});

test("未対応の引数と不正な期限は実行しない", () => {
  assert.equal(parseArgs([]), undefined);
  assert.equal(parseArgs(["--deadline-ms", "1000"]), undefined, "サブコマンドが無ければ実行しない");
  // --help は CLI が parseArgs より先に処理する (実行しない引数として undefined を返す経路は無い)
  assert.throws(() => parseArgs(["--help"]), /未対応/);
  for (const argv of [
    ["shot"],
    ["--self-test", "--bogus"],
    ["--self-test", "--deadline-ms"],
    ["--self-test", "--deadline-ms", "0"],
    ["--self-test", "--deadline-ms", "abc"],
  ]) {
    assert.throws(() => parseArgs(argv), /未対応|期限/, argv.join(" "));
  }
  for (const value of ["0", "-1", "1.5", "NaN", "abc", "Infinity", ""]) {
    assert.throws(() => parseDeadlineMs(value), /期限/, value);
  }
  assert.equal(parseDeadlineMs("1e3"), 1000);
  assert.equal(parseDeadlineMs(" 120000 "), 120_000);
});

test("資源上限は CLI の案内と一致する", () => {
  assert.deepEqual(VIEWPORT, { width: 1280, height: 720 });
  assert.equal(MAX_OUTPUTS, 1);
  assert.equal(MAX_IMAGE_BYTES, 64 * 1024 * 1024);
  assert.match(USAGE, /期限 120000 ms/);
  assert.match(USAGE, /同時実行 3 件/);
  assert.match(USAGE, /ループバック \(127\.0\.0\.1 \/ localhost \/ \[::1\]\) 以外へは通信しない/);
  // 常に付ける起動引数は CLI の仕様として案内する (何を付けるかを利用者から見えるようにする)
  for (const arg of BROWSER_ARGUMENTS) assert.ok(USAGE.includes(arg), arg);
});
