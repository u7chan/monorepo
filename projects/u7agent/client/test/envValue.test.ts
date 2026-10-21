// 環境変数タブの値の表示判定。2 行に収まるかの判定、開閉の文言、<wbr> の分割位置を固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  ENV_VALUE_COLLAPSE_LABEL,
  ENV_VALUE_ERROR_NOTE,
  ENV_VALUE_EXPAND_LABEL,
  ENV_VALUE_PENDING,
  envValueOverflows,
  envValueSegments,
  envValueToggleLabel,
} from "../src/lib/envValue";

test("判定: 2 行に収まっている値は省略しない", () => {
  assert.equal(envValueOverflows({ scrollHeight: 32, clientHeight: 32 }), false);
});

test("判定: 1px の差は端数の丸めとして省略しない", () => {
  assert.equal(envValueOverflows({ scrollHeight: 33, clientHeight: 32 }), false);
});

test("判定: clamp の高さを超えたら省略する (scrollHeight は全文の高さを返す)", () => {
  assert.equal(envValueOverflows({ scrollHeight: 34, clientHeight: 32 }), true);
  assert.equal(envValueOverflows({ scrollHeight: 160, clientHeight: 32 }), true);
});

test("文言: 開いていないときは「すべて表示」、開いたら「たたむ」", () => {
  assert.equal(envValueToggleLabel(false), ENV_VALUE_EXPAND_LABEL);
  assert.equal(envValueToggleLabel(true), ENV_VALUE_COLLAPSE_LABEL);
  assert.equal(ENV_VALUE_EXPAND_LABEL, "すべて表示");
  assert.equal(ENV_VALUE_COLLAPSE_LABEL, "たたむ");
});

test("文言: 未取得の印と、値だけ取れなかった行の注記は再読み込みへ案内する", () => {
  assert.equal(ENV_VALUE_PENDING, "…");
  assert.ok(ENV_VALUE_ERROR_NOTE.includes("再読み込み"), "行単位の再試行が無いためタブの導線を示す");
});

test("<wbr>: / ? & @ の直後だけが折り返しの候補になる", () => {
  assert.deepEqual(envValueSegments("postgres://app@db.example.com:5432/app?sslmode=require&pool=10"), [
    "postgres:/",
    "/",
    "app@",
    "db.example.com:5432/",
    "app?",
    "sslmode=require&",
    "pool=10",
  ]);
  assert.deepEqual(envValueSegments("http://localhost:3000"), ["http:/", "/", "localhost:3000"]);
});

test("<wbr>: 区切りの無い値と空の値は分割しない", () => {
  // 区切りが無い長い語は overflow-wrap: anywhere が保険として折る
  assert.deepEqual(envValueSegments("production"), ["production"]);
  assert.deepEqual(envValueSegments("abcdef"), ["abcdef"]);
  assert.deepEqual(envValueSegments(""), []);
});

test("<wbr>: 分割しても原文が変わらない (コピーは原文のまま)", () => {
  const value = "http://localhost:3000/api?x=1&y=2@z";
  assert.equal(envValueSegments(value).join(""), value);
});

test("<wbr>: 改行を含む値は行を割らず、改行をそのまま残す", () => {
  const value = '{\n  "endpoint": "https://api.example.com",\n  "key": "a@b"\n}';
  assert.equal(envValueSegments(value).join(""), value);
  assert.deepEqual(envValueSegments("a\nb"), ["a\nb"]);
});

test("<wbr>: 区切りで終わる値には空の断片を足さない", () => {
  assert.deepEqual(envValueSegments("https://"), ["https:/", "/"]);
  assert.deepEqual(envValueSegments("a/"), ["a/"]);
});
