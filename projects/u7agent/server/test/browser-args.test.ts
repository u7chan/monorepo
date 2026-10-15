// CLI の引数 (server/src/browser/args.ts) と資源上限の既定を検証する。
// サブコマンドごとに受け付けるフラグが違い、保存名と URL はブラウザを起動する前に落とす (資源の無駄と事故を防ぐ)。

import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, USAGE, type CliOptions, type ShotCliOptions } from "../src/browser/args";
import { BROWSER_ARGUMENTS } from "../src/browser/policy";
import {
  CALL_DEADLINE_MS,
  MAX_CHECK_OUTPUT_BYTES,
  MAX_IMAGE_BYTES,
  MAX_OUTPUTS,
  MAX_VIEWPORT_DIMENSION,
  parseDeadlineMs,
  VIEWPORT,
} from "../src/browser/limits";

/** サブコマンドを確かめてから中身を読む (テストの assert が型を絞れないため) */
function parsed(argv: string[]): CliOptions {
  const options = parseArgs(argv);
  assert.ok(options, `引数を解釈できません: ${argv.join(" ")}`);
  return options;
}

function shotOptions(argv: string[]): ShotCliOptions {
  const options = parsed(argv);
  assert.equal(options.kind, "shot");
  return options as ShotCliOptions;
}

test("サブコマンドが無ければ何も実行しない", () => {
  assert.equal(parseArgs([]), undefined);
  assert.equal(parseArgs(["--deadline-ms", "1000"]), undefined, "--deadline-ms だけでは実行しない");
  // --help は CLI が parseArgs より先に処理する (実行しない引数として undefined を返す経路は無い)
  assert.equal(parseArgs(["--help"]), undefined);
  assert.throws(() => parseArgs(["shots", "http://127.0.0.1/", "a.png"]), /未対応のサブコマンド/);
});

test("--self-test は既定の期限で実行し、--deadline-ms で上書きできる", () => {
  assert.deepEqual(parseArgs(["--self-test"]), { kind: "self-test", deadlineMs: CALL_DEADLINE_MS });
  assert.deepEqual(parseArgs(["--self-test", "--deadline-ms", "1500"]), { kind: "self-test", deadlineMs: 1500 });
  assert.equal(CALL_DEADLINE_MS, 120_000);
});

test("shot は URL と保存名を取り、既定の viewport とフラグを重ねる", () => {
  assert.deepEqual(parseArgs(["shot", "http://127.0.0.1:3000/", "shot.png"]), {
    kind: "shot",
    url: "http://127.0.0.1:3000/",
    out: "shot.png",
    viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
    fullPage: false,
    deadlineMs: CALL_DEADLINE_MS,
  });
  assert.deepEqual(
    parseArgs([
      "shot",
      "http://127.0.0.1:3000/app",
      "shots/home-1.png",
      "--width",
      "375",
      "--height",
      "667",
      "--full-page",
      "--wait-for-selector",
      "#app",
      "--wait-for-timeout",
      "250",
      "--deadline-ms",
      "9000",
    ]),
    {
      kind: "shot",
      url: "http://127.0.0.1:3000/app",
      out: "shots/home-1.png",
      viewport: { width: 375, height: 667 },
      fullPage: true,
      waitForSelector: "#app",
      waitForTimeoutMs: 250,
      deadlineMs: 9000,
    },
  );
  // 片方だけ指定したときはもう片方の既定を保つ
  assert.deepEqual(shotOptions(["shot", "http://127.0.0.1/", "a.png", "--width", "375"]).viewport, {
    width: 375,
    height: VIEWPORT.height,
  });
});

test("dom と check は URL 1 つだけを受け付ける", () => {
  assert.deepEqual(parseArgs(["dom", "http://127.0.0.1:3000/"]), {
    kind: "dom",
    url: "http://127.0.0.1:3000/",
    deadlineMs: CALL_DEADLINE_MS,
  });
  assert.deepEqual(parseArgs(["check", "http://127.0.0.1:3000/", "--wait-for-selector", "#app"]), {
    kind: "check",
    url: "http://127.0.0.1:3000/",
    waitForSelector: "#app",
    deadlineMs: CALL_DEADLINE_MS,
  });
});

test("保存名は cwd 相対の .png だけを受け付ける", () => {
  for (const name of ["shot.png", "shots/home.PNG", "a-1.png"]) {
    assert.deepEqual(shotOptions(["shot", "http://127.0.0.1/", name]).out, name);
  }
  for (const name of ["/abs.png", "../up.png", "shots/./a.png", "a.jpg", "a", "a//b.png", ""]) {
    assert.throws(() => parseArgs(["shot", "http://127.0.0.1/", name]), /保存|絶対|使えません|png/, name);
  }
});

test("URL と viewport と待ち時間の不正は実行前に落とす", () => {
  assert.throws(() => parseArgs(["dom", "not a url"]), /URL/);
  assert.throws(() => parseArgs(["shot", "http://127.0.0.1/", "a.png", "--width", "0"]), /--width/);
  assert.throws(() => parseArgs(["shot", "http://127.0.0.1/", "a.png", "--height", "abc"]), /--height/);
  assert.throws(
    () => parseArgs(["shot", "http://127.0.0.1/", "a.png", "--width", String(MAX_VIEWPORT_DIMENSION + 1)]),
    /1〜8192/,
  );
  assert.throws(() => parseArgs(["shot", "http://127.0.0.1/", "a.png", "--wait-for-timeout", "0"]), /正の整数/);
  assert.throws(() => parseArgs(["check", "http://127.0.0.1/", "--wait-for-selector", "  "]), /空/);
});

test("サブコマンドごとに受け付けないフラグと位置引数を拒否する", () => {
  const cases: Array<[string[], RegExp]> = [
    [["shot"], /使い方/],
    [["shot", "http://127.0.0.1/"], /使い方/],
    [["shot", "http://127.0.0.1/", "a.png", "extra"], /使い方/],
    [["shot", "http://127.0.0.1/", "a.png", "--bogus"], /未対応の引数/],
    [["shot", "http://127.0.0.1/", "a.png", "--width"], /値がありません/],
    [["dom", "http://127.0.0.1/", "--width", "100"], /未対応の引数/],
    [["check", "http://127.0.0.1/", "--full-page"], /未対応の引数/],
    [["check"], /使い方/],
    [["--self-test", "--bogus"], /未対応の引数/],
    [["--self-test", "--deadline-ms"], /値がありません/],
    [["--self-test", "extra"], /使い方/],
  ];
  for (const [argv, pattern] of cases) assert.throws(() => parseArgs(argv), pattern, argv.join(" "));
});

test("期限の値は正の整数だけを受け付ける", () => {
  for (const value of ["0", "-1", "1.5", "NaN", "abc", "Infinity", ""]) {
    assert.throws(() => parseDeadlineMs(value), /期限/, value);
  }
  assert.equal(parseDeadlineMs("1e3"), 1000);
  assert.equal(parseDeadlineMs(" 120000 "), 120_000);
  assert.throws(() => parseArgs(["--self-test", "--deadline-ms", "abc"]), /期限/, "不正な期限は実行しない");
});

test("資源上限は CLI の案内と一致する", () => {
  assert.deepEqual(VIEWPORT, { width: 1280, height: 720 });
  assert.equal(MAX_OUTPUTS, 1);
  assert.equal(MAX_IMAGE_BYTES, 64 * 1024 * 1024);
  assert.equal(MAX_CHECK_OUTPUT_BYTES, 64 * 1024);
  assert.match(USAGE, /期限 120000 ms/);
  assert.match(USAGE, /同時実行 3 件/);
  assert.match(USAGE, /ループバック \(127\.0\.0\.1 \/ localhost \/ \[::1\]\) 以外へは通信しない/);
  // サブコマンドと終了コードは利用者から見た契約なので案内する
  for (const command of ["shot <url> <out.png>", "dom <url>", "check <url>", "--self-test"]) {
    assert.ok(USAGE.includes(command), command);
  }
  assert.match(USAGE, /既存のファイルは上書きせず/);
  assert.ok(USAGE.includes("0 正常 / 1 検証失敗"), "終了コードの意味を案内する");
  assert.ok(USAGE.includes("2 起動・入力エラー"), "起動・入力エラーの終了コードを案内する");
  // 常に付ける起動引数は CLI の仕様として案内する (何を付けるかを利用者から見えるようにする)
  for (const arg of BROWSER_ARGUMENTS) assert.ok(USAGE.includes(arg), arg);
});
