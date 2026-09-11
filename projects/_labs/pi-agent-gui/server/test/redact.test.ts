import assert from "node:assert/strict";
import test from "node:test";
import {
  createSecretMasker,
  createStreamingSecretMasker,
  MIN_SECRET_LENGTH,
  REDACTED,
} from "../src/redact";

const KEY = "sk-ant-dummy-0123456789abcdef";
const OTHER = "AIzaSyDummyDummyDummy123456789";

test("masks known secret values wherever they appear", () => {
  const masker = createSecretMasker([KEY, OTHER]);
  assert.equal(masker.mask(`before ${KEY} after`), `before ${REDACTED} after`);
  assert.equal(masker.mask(KEY), REDACTED);
  assert.equal(masker.mask(`${KEY}:${KEY}`), `${REDACTED}:${REDACTED}`);
  assert.equal(masker.mask(`env | grep ${OTHER}`), "env | grep [REDACTED]");
});

test("masks the longest value first when secrets overlap", () => {
  const short = "abcdefgh";
  const long = `${short}XYZ12345`;
  const masker = createSecretMasker([short, long]);
  assert.equal(masker.mask(`x ${long} y`), `x ${REDACTED} y`);
  // 長い値を先に潰した結果、短い値が単独で現れた場合のみ置換される
  assert.equal(masker.mask(`x ${short} y`), `x ${REDACTED} y`);
});

test("registering values is not filtered by length by default (explicit opt-in)", () => {
  const masker = createSecretMasker(["", "   ", "abc", KEY]);
  // 空文字・空白のみは常に除外。短い値は明示指定されれば保護対象。
  assert.deepEqual(masker.secrets, [KEY, "abc"]);
  assert.equal(masker.mask("xyz abc"), "xyz [REDACTED]");
});

test("minLength option drops short values (auto-discovered keys)", () => {
  const masker = createSecretMasker(["", "   ", "a".repeat(MIN_SECRET_LENGTH - 1), KEY], {
    minLength: MIN_SECRET_LENGTH,
  });
  assert.deepEqual(masker.secrets, [KEY]);
});

test("leaves output without secrets untouched", () => {
  const masker = createSecretMasker([KEY, OTHER]);
  const normal = [
    "total 48",
    "drwxr-x--- 8 node node 4096 Sep 11 16:25 .",
    "-rw-r--r-- 1 node node  482 Sep 11 00:28 .env.example",
    "GIT_PAGER=cat LANG=ja_JP.UTF-8",
  ].join("\n");
  assert.equal(masker.mask(normal), normal);
});

test("maskAccumulated holds back a trailing partial secret and completes it later", () => {
  const masker = createSecretMasker([KEY]);
  const partial = `log line ${KEY.slice(0, KEY.length - 4)}`;
  const held = masker.maskAccumulated(partial);
  assert.ok(!held.includes(KEY.slice(0, KEY.length - 4)), "partial tail must be held back");

  const complete = masker.maskAccumulated(`${partial}${KEY.slice(KEY.length - 4)} tail`);
  assert.equal(complete, `log line ${REDACTED} tail`);
});

test("maskAccumulated returns masked text as-is when the tail is safe", () => {
  const masker = createSecretMasker([KEY]);
  assert.equal(masker.maskAccumulated(`out ${KEY} done`), `out ${REDACTED} done`);
});

test("streaming masker never emits a raw secret across chunk boundaries", () => {
  const masker = createSecretMasker([KEY, OTHER]);
  const stream = createStreamingSecretMasker(masker);
  const text = `command output: ${KEY} and ${OTHER} end`;
  let emitted = "";
  // 2文字ずつの細かいチャンクに分割して流す
  for (let index = 0; index < text.length; index += 2) {
    emitted += stream.push(text.slice(index, index + 2));
  }
  emitted += stream.flush();
  assert.equal(emitted, `command output: ${REDACTED} and ${REDACTED} end`);
  assert.ok(!emitted.includes(KEY));
  assert.ok(!emitted.includes(OTHER));
});

test("streaming masker keeps the text identical when there is no secret", () => {
  const stream = createStreamingSecretMasker(createSecretMasker([]));
  const text = "完全に秘密を含まない日本語のテキストでも split されない";
  let emitted = "";
  for (const char of text) emitted += stream.push(char);
  emitted += stream.flush();
  assert.equal(emitted, text);
});

test("interruption: held-back partial is not streamed early and flush keeps text integrity", () => {
  const masker = createSecretMasker([KEY]);
  const partial = KEY.slice(0, 8);
  const stream = createStreamingSecretMasker(masker);
  const beforeFlush = stream.push(`out ${partial}`);
  assert.ok(!beforeFlush.includes(partial), "partial tail must be held back while streaming");
  // 中断: 保留分は完全体ではないため flush で素通しになる (テキストを失わない)。
  // 完全体が届いていれば push の時点でマスク済みなので、生の完全体は出ない。
  const emitted = beforeFlush + stream.flush();
  assert.equal(emitted, `out ${partial}`);

  // 完全体が届いた後に中断した場合も、生の値は出ない
  const resumed = createStreamingSecretMasker(masker);
  let second = resumed.push(`out ${KEY}`);
  second += resumed.flush();
  assert.equal(second, `out ${REDACTED}`);
});
