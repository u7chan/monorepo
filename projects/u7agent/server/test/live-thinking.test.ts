// 実行中ランの thinking 末尾 (SSE `status.thinking`) のコントローラ。実タイマーを使わず、
// 時計と scheduler を差し替えて間引き・即時クリア・秘密値の境界を検査する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  createLiveThinking,
  LIVE_THINKING_MAX_CHARS,
  LIVE_THINKING_THROTTLE_MS,
  tailText,
  withoutThinking,
} from "../src/live-thinking";
import { createSecretMasker, REDACTED, type SecretMasker } from "../src/redact";
import type { EventEntry } from "../src/schema";

function harness(options: { secrets?: string[]; masker?: SecretMasker; maxChars?: number } = {}) {
  let at = 0;
  const timers: { at: number; deliver: () => void; cancelled: boolean }[] = [];
  const out: string[] = [];
  const thinking = createLiveThinking({
    masker: options.masker ?? createSecretMasker(options.secrets ?? []),
    emit: (tail) => out.push(tail),
    now: () => at,
    throttleMs: LIVE_THINKING_THROTTLE_MS,
    ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }),
    // 実タイマーを使わない (テストの進行は advance だけで決める)
    schedule: (deliver, delayMs) => {
      const timer = { at: at + delayMs, deliver, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  const advance = (ms: number): void => {
    at += ms;
    for (const timer of timers) {
      if (timer.cancelled || timer.at > at) continue;
      timer.cancelled = true;
      timer.deliver();
    }
  };
  return { thinking, out, advance };
}

test("tailText は code point 単位で末尾を残す (サロゲートペアを割らない)", () => {
  assert.equal(tailText("あいうえお", 3), "うえお");
  assert.equal(tailText("あいう", 10), "あいう");
  assert.equal(tailText("あいう", 0), "");
  // "🙂" は 2 UTF-16 code unit。文字数で切ると壊れる
  const tail = tailText("🙂🙂🙂", 2);
  assert.equal(tail, "🙂🙂");
  assert.deepEqual(Array.from(tail).length, 2);
});

test("最初の delta は即時に配り、以降は 500ms で間引く", () => {
  const { thinking, out, advance } = harness();
  thinking.push("考え");
  assert.deepEqual(out, ["考え"], "最初の delta は待たない");
  thinking.push("中");
  assert.deepEqual(out, ["考え"], "500ms 未満の delta はまとめる");
  advance(LIVE_THINKING_THROTTLE_MS);
  assert.deepEqual(out, ["考え", "考え中"]);
  thinking.push("です");
  advance(LIVE_THINKING_THROTTLE_MS);
  assert.deepEqual(out, ["考え", "考え中", "考え中です"]);
});

test("上限を超えた末尾だけを配る", () => {
  const { thinking, out } = harness({ maxChars: 4 });
  thinking.push("abcdef");
  assert.deepEqual(out, ["cdef"]);
});

test("clear は保留中の配信を捨て、block を閉じる (次の delta は最初の delta として即時)", () => {
  const { thinking, out, advance } = harness();
  thinking.push("考え");
  thinking.push("中");
  thinking.clear();
  advance(LIVE_THINKING_THROTTLE_MS * 2);
  assert.deepEqual(out, ["考え"], "clear の後に保留分を出さない");
  thinking.push("次のブロック");
  assert.deepEqual(out, ["考え", "次のブロック"], "新しいブロックの最初の delta は即時");
});

test("cancelPending は配信だけを取り消し、masker の境界バッファと次の delta を残す", () => {
  const secret = "sk-live-thinking-0123456789";
  const { thinking, out, advance } = harness({ secrets: [secret] });
  thinking.push("最初");
  thinking.push("の続き");
  thinking.cancelPending();
  advance(LIVE_THINKING_THROTTLE_MS * 2);
  assert.deepEqual(out, ["最初"], "取り消したスナップショットは配らない");
  thinking.push("再開");
  assert.deepEqual(out, ["最初", "最初の続き再開"], "次の delta は通常どおり配る");
});

test("秘密値が cancelPending をまたいで分割されても生のまま出ない", () => {
  const secret = "sk-live-thinking-0123456789";
  const { thinking, out, advance } = harness({ secrets: [secret] });
  thinking.push(secret.slice(0, 8));
  // 前方一致の末尾は保留されているため、この時点では何も配らない
  assert.equal(out.length, 0);
  thinking.cancelPending();
  thinking.push(`${secret.slice(8)} です`);
  advance(LIVE_THINKING_THROTTLE_MS);
  assert.ok(out.length > 0);
  for (const tail of out) assert.ok(!tail.includes(secret), "生のキーを配らない");
  assert.ok(out.at(-1)?.includes(REDACTED), "保留をまたいだ断片も mask される");
});

test("thinking_end 相当の clear では保留末尾を公開しない (flush の戻り値を足さない)", () => {
  const secret = "sk-live-thinking-0123456789";
  const { thinking, out, advance } = harness({ secrets: [secret] });
  // 既知の秘密値の前方一致で途絶えた状態を作る (flush すれば末尾を欠いた断片が返る)
  thinking.push(secret.slice(0, 10));
  assert.equal(out.length, 0);
  thinking.clear();
  advance(LIVE_THINKING_THROTTLE_MS * 2);
  assert.equal(out.length, 0, "保留末尾は捨てる");
});

test("masker が例外を投げても raw へフォールバックせず、run を止めない", () => {
  const boom = (): never => {
    throw new Error("masker failed");
  };
  const masker: SecretMasker = {
    secrets: [],
    maxSecretLength: 0,
    mask: boom,
    maskSafe: boom,
    maskAccumulated: boom,
  };
  const { thinking, out, advance } = harness({ masker });
  assert.doesNotThrow(() => thinking.push("raw の本文"));
  advance(LIVE_THINKING_THROTTLE_MS * 2);
  assert.equal(out.length, 0, "mask できなかった本文を出さない");
  thinking.clear();
  thinking.push("次の本文");
  advance(LIVE_THINKING_THROTTLE_MS * 2);
  assert.equal(out.length, 0, "例外の後も raw を出さない");
});

// What: 途中で masker が失敗しても、同じ thinking ブロックの残りを新しい masker で処理しない
// (失敗した masker は保留境界を失っており、分割された秘密値の先頭が raw で出る)。
test("masker が失敗したブロックは、次の明示的な境界まで 1 文字も配らない", () => {
  const secret = "sk-synthetic-review-0123456789";
  const inner = createSecretMasker([secret]);
  let calls = 0;
  const masker: SecretMasker = {
    ...inner,
    // 2 回目 (2 個目の delta) の mask だけを失敗させる
    mask: (text: string): string => {
      calls += 1;
      if (calls === 2) throw new Error("masker failed");
      return inner.mask(text);
    },
  };
  const { thinking, out, advance } = harness({ masker });

  thinking.push(secret.slice(0, 6));
  thinking.push(secret.slice(6, 12));
  // 失敗した後に届く同じブロックの delta。新しい masker で処理すると "-review-0123456789" が出る
  thinking.push(secret.slice(12));
  advance(LIVE_THINKING_THROTTLE_MS * 2);
  assert.equal(out.length, 0, "失敗したブロックの残りを配信しない");

  thinking.cancelPending();
  thinking.push("まだ同じブロック");
  advance(LIVE_THINKING_THROTTLE_MS * 2);
  assert.equal(out.length, 0, "cancelPending では失敗したブロックを解かない");

  // 明示的な境界 (次の thinking ブロック) から通常どおり再開する
  thinking.clear();
  thinking.push("次のブロック");
  advance(LIVE_THINKING_THROTTLE_MS * 2);
  assert.deepEqual(out, ["次のブロック"], "新しいブロックは配信できる");
});

test("withoutThinking は status から thinking だけを落とす", () => {
  const entry = { seq: 3, type: "status", data: { state: "thinking", text: "考え中…", thinking: "末尾" }, at: 1 };
  assert.deepEqual(withoutThinking(entry as EventEntry), {
    seq: 3,
    type: "status",
    data: { state: "thinking", text: "考え中…" },
    at: 1,
  });
  const other = { seq: 4, type: "text", data: { delta: "本文" }, at: 2 };
  assert.equal(withoutThinking(other as EventEntry), other, "status 以外はそのまま返す");
});

test("`status.thinking` の上限は status の契約と同じ値を使う", () => {
  assert.equal(LIVE_THINKING_MAX_CHARS, 1200);
});
