// 長い user メッセージの折りたたみ。client に DOM テスト基盤が無いため、次の 4 つを固定する。
//   1. 見積り: user の長文は clamp の高さで頭打ちになり、仮想スクロールが過大な高さを予約しない
//   2. 計測: あふれの判定が縮小の遷移中 (clientHeight が動く) でもぶれず、収まれば clamp を外す
//   3. UserMessageBody の配線: clamp と開閉ボタンの出し分け・実測値の受け渡し・あふれ判定
//   4. 見た目: styles/index.css の clamp / フェード / 矢印が @layer components にある
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { estimateChatItemHeight } from "../src/lib/chatItems";
import type { Bubble } from "../src/lib/chatTypes";
import { measureUserMessageClamp, USER_MESSAGE_CLAMP_PX } from "../src/lib/userMessage";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

function bubble(role: Bubble["role"], text: string): Bubble {
  return { id: 1, entryId: "e1", context: "active", role, text, tools: [], skillLoads: [] };
}

test("見積り: user の長文は clamp の高さで頭打ちになる", () => {
  const long = "あ".repeat(3000);
  const user = estimateChatItemHeight({ kind: "message", key: "m", bubble: bubble("user", long) });
  const assistant = estimateChatItemHeight({ kind: "message", key: "m", bubble: bubble("assistant", long) });
  assert.equal(user, 64 + USER_MESSAGE_CLAMP_PX);
  assert.ok(user < assistant, "user の折りたたみが仮想スクロールの見積りに効いていない");
});

test("計測: 収まっているうちは clamp しない", () => {
  assert.deepEqual(measureUserMessageClamp({ scrollHeight: 180, clientHeight: 180, clampHeight: 0 }), {
    clampHeight: 0,
    clamped: false,
  });
});

test("計測: あふれた時点の clientHeight を clamp の高さとして固定する", () => {
  const first = measureUserMessageClamp({ scrollHeight: 1500, clientHeight: 240, clampHeight: 0 });
  assert.deepEqual(first, { clampHeight: 240, clamped: true });
  // 縮小の遷移中は clientHeight がまだ全文の高さに近い。確定済みの clamp の高さと比べるので、
  // ボタンが一瞬消える判定 (clamped: false) にならない
  assert.deepEqual(measureUserMessageClamp({ scrollHeight: 1500, clientHeight: 1500, clampHeight: 240 }), {
    clampHeight: 240,
    clamped: true,
  });
});

test("計測: 幅が広がって収まったら clamp を外す", () => {
  assert.deepEqual(measureUserMessageClamp({ scrollHeight: 200, clientHeight: 200, clampHeight: 240 }), {
    clampHeight: 240,
    clamped: false,
  });
});

test("MessageView は user の本文を UserMessageBody に委ねる", () => {
  const messageView = read("src/components/chat/MessageView.tsx");
  assert.ok(messageView.includes("<UserMessageBody text={bodyText} />"), "user の本文が折りたたまれていない");
  // 本文以外 (添付 / スキル呼び出し / コピー) は折りたたみの対象外のまま
  assert.ok(messageView.includes("<AttachedFiles files={files}"), "添付が本文と同じ入れ物に入っている");
});

test("UserMessageBody: clamp は常に当て、開閉は実測値で行う", () => {
  const body = read("src/components/chat/UserMessageBody.tsx");
  // 切り取りはクラス 1 つで、しきい値は CSS
  assert.ok(body.includes("user-message-clamp break-words whitespace-pre-wrap"), "本文に clamp が当たっていない");
  assert.ok(body.includes("user-message-clamp-open"), "開いた状態のクラスが無い");
  assert.ok(
    body.includes('"--user-message-height"'),
    "開いた高さを CSS 変数へ渡していない (interpolate-size の無いブラウザーでクリップされる)",
  );
  // あふれの判定は確定済みの clamp の高さを基準にする (clientHeight を直接使うと遷移中にボタンが消える)
  assert.ok(body.includes("measureUserMessageClamp({"), "あふれの判定を純関数へ委ねていない");
  assert.ok(body.includes("clampHeightRef"), "確定済みの clamp の高さを基準にしていない");
  // 開いている間も scrollHeight は全文の高さを返すため、開いた高さの測り直しは続ける
  assert.ok(body.includes("if (expanded) setOpenHeight(el.scrollHeight);"), "開いた高さを測り直していない");
  // display: none で mount されても、サイズが付いた時点で測り直す
  assert.ok(body.includes("ResizeObserver"), "非表示から表示へ戻ったときに測り直さない");
});

test("UserMessageBody: 開閉ボタンとフェードはあふれているときだけ出す", () => {
  const body = read("src/components/chat/UserMessageBody.tsx");
  assert.ok(body.includes("aria-expanded={expanded}"), "開閉の状態が読み上げに乗っていない");
  assert.ok(body.includes("aria-controls={bodyId}"), "開閉ボタンと本文が結び付いていない");
  assert.ok(body.includes('aria-hidden="true"'), "フェードを読み上げに出している");
  assert.ok(body.includes('{expanded ? "折りたたむ" : "続きを表示"}'), "開閉のラベルが状態と対応していない");
});

test("見た目: clamp / フェード / 矢印は @layer components の専用クラス", () => {
  const css = read("src/styles/index.css");
  const layer = css.indexOf("@layer components");
  assert.ok(layer >= 0, "@layer components が無い");
  for (const name of [
    ".user-message-clamp",
    ".user-message-clamp-open",
    ".user-message-fade",
    ".user-message-chevron",
  ]) {
    const definition = css.indexOf(`${name} {`);
    assert.ok(definition > layer, `${name} が @layer components の外にある`);
  }
  const clamp = css.slice(css.indexOf(".user-message-clamp {"), css.indexOf(".user-message-clamp-open {"));
  assert.ok(clamp.includes("max-block-size: 15rem;"), "切り取る高さが 15rem でない");
  assert.ok(clamp.includes("transition: max-block-size 200ms ease;"), "開閉が遷移しない");
  const open = css.slice(css.indexOf(".user-message-clamp-open {"), css.indexOf(".user-message-fade {"));
  assert.ok(open.includes("max-block-size: var(--user-message-height, none);"), "開いた高さの受け取り先が無い");
  const fade = css.slice(css.indexOf(".user-message-fade {"), css.indexOf(".user-message-chevron {"));
  assert.ok(fade.includes("var(--c-accent-bright)"), "フェードがバブルの面の色へ溶けない");
  assert.ok(fade.includes("pointer-events: none;"), "フェードがコピーや選択を邪魔する");
  // 動きを止める設定では 3 つとも遷移させない
  const reduced = css.slice(
    css.indexOf("@media (prefers-reduced-motion: reduce)", css.indexOf(".user-message-chevron")),
  );
  for (const name of [".user-message-clamp", ".user-message-fade", ".user-message-chevron"]) {
    assert.ok(reduced.includes(name), `${name} が reduced-motion の対象外`);
  }
});
