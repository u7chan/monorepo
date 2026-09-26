// チャットの自動追従の判定と配線。client に DOM テスト基盤が無いため、しきい値の境界と scroll の
// 判定は純関数 (lib/chatScroll) で固定し、ChatArea / App の配線はソース走査で固定する。
// スクロール・ResizeObserver・フォーカスそのものは実ブラウザーでの手動受入に残る。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ScrollToBottomButton } from "../src/components/chat/ScrollToBottomButton";
import { CHAT_FOLLOW_THRESHOLD, isAtBottom, resolveScrollFollow } from "../src/lib/chatScroll";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

const chatArea = read("src/components/ChatArea.tsx");
const app = read("src/App.tsx");

test("最下部の判定はしきい値 48px ちょうどまで追従する", () => {
  // 高さ 800 の容器に内容 2000 を入れた状態 (最下部は scrollTop = 1200)
  const at = (scrollTop: number) => ({ scrollTop, scrollHeight: 2000, clientHeight: 800 });

  assert.equal(isAtBottom(at(1200)), true); // ちょうど最下部
  assert.equal(isAtBottom(at(1200 - CHAT_FOLLOW_THRESHOLD)), true); // しきい値ちょうど
  assert.equal(isAtBottom(at(1200 - CHAT_FOLLOW_THRESHOLD - 0.5)), false); // 端数で 1 つ外
  assert.equal(isAtBottom(at(0)), false); // 上端
});

test("内容が収まっている / 空のときは最下部とみなす", () => {
  // 内容が容器に収まる (scrollTop は常に 0 になる) ときは、追従を外す余地がない
  assert.equal(isAtBottom({ scrollTop: 0, scrollHeight: 400, clientHeight: 800 }), true);
  // 高さを持たない容器 (非表示中や未描画) でも判定できる
  assert.equal(isAtBottom({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }), true);
});

test("追従中は位置が増える scroll (レイアウト起因 / snap の代入) で追従を外さない", () => {
  // 右パネルを開いた再折り返し (実測: scrollHeight 10291 → 13021、最下部 12347)。アンカリングが
  // scrollTop を 9374 → 11922 へ増やし、最下部から 425px 離れた scroll を ResizeObserver より先に配る
  const resized = { scrollHeight: 13021, clientHeight: 674 };
  assert.deepEqual(resolveScrollFollow({ follow: true, previousTop: 9374, scrollTop: 11922, ...resized }), {
    follow: true,
    snap: true,
  });
  // 位置が同じ (snap の代入が動かさなかった) もユーザー操作ではない。最下部なら書き戻さない
  assert.deepEqual(resolveScrollFollow({ follow: true, previousTop: 12347, scrollTop: 12347, ...resized }), {
    follow: true,
    snap: false,
  });
});

test("上へ戻す scroll は追従中でも距離で判定する", () => {
  const resized = { scrollHeight: 13021, clientHeight: 674 };
  // 48px ちょうどまでは追従を続け、端数で外れる
  assert.deepEqual(resolveScrollFollow({ follow: true, previousTop: 12347, scrollTop: 12347 - 48, ...resized }), {
    follow: true,
    snap: false,
  });
  assert.deepEqual(resolveScrollFollow({ follow: true, previousTop: 12347, scrollTop: 12347 - 49, ...resized }), {
    follow: false,
    snap: false,
  });
  // snap の代入とイベント配送の間にユーザーが戻した場合も、位置が減るのでこの経路で外れる
  assert.deepEqual(resolveScrollFollow({ follow: true, previousTop: 9000, scrollTop: 8000, ...resized }), {
    follow: false,
    snap: false,
  });
});

test("読み返し中は位置が増えても追従を戻さず、48px 以内へ戻ったときだけ再開する", () => {
  const resized = { scrollHeight: 13021, clientHeight: 674 };
  // レイアウト起因で位置が増えても、読み位置を動かさない
  assert.deepEqual(resolveScrollFollow({ follow: false, previousTop: 5000, scrollTop: 6000, ...resized }), {
    follow: false,
    snap: false,
  });
  assert.deepEqual(resolveScrollFollow({ follow: false, previousTop: 5000, scrollTop: 12347 - 48, ...resized }), {
    follow: true,
    snap: false,
  });
});

test("ChatArea は follow で gate し、非表示中はスクロールを書かない", () => {
  // follow の書き込みは snapToBottom に閉じ、visible を先に見る (設定ページ中は scrollHeight が 0)
  assert.ok(chatArea.includes("if (!visible || !el) return;"));
  assert.ok(chatArea.includes("el.scrollTop = el.scrollHeight;"));
  // follow が外れている (読み返し中) ときは Effect でも位置を動かさない
  assert.ok(chatArea.includes("if (!followRef.current) return;"));
  // 0 サイズの容器 (非表示中の ResizeObserver の通知) も書かない
  assert.ok(chatArea.includes("if (!el || el.clientHeight === 0) return;"));
});

test("ChatArea は送信 / 会話の切替 / 表示への復帰 / リサイズで追従を立てる", () => {
  // 送信はローカルエコーの増加で拾う (バブルの形では resync と区別できない)
  assert.ok(chatArea.includes("if (sendSeq === prevSendSeqRef.current) return;"));
  // 会話の切替は "" からの遷移も含めて揃える
  assert.ok(chatArea.includes("if (sessionId === prevSessionIdRef.current) return;"));
  assert.ok(chatArea.includes("if (!visible || !followRef.current) return;"));
  // 容器と本文の両方を見る (コンポーザの伸縮・添付の遅延ロード・パネルのドラッグ)
  assert.ok(chatArea.includes("observer.observe(section);"));
  assert.ok(chatArea.includes("observer.observe(content);"));
  // scroll の判定は純関数へ委ね、位置の向き (上へ戻す操作か) を見る。自分が書いた位置だけを控える
  // 旧方式は、右パネルの開閉でブラウザーが起こした scroll をユーザー操作と誤認して追従を外した
  assert.ok(chatArea.includes("resolveScrollFollow({"));
  assert.ok(!chatArea.includes("snapTopRef"));
  // 次に届く scroll と向きを比べる基準は、snap の代入でも更新する
  assert.ok(chatArea.includes("lastTopRef.current = el.scrollTop;"));
});

test("最下部ボタンは追従が外れていてメッセージがあるときだけ出す", () => {
  assert.ok(chatArea.includes("{!follow && bubbles.length > 0 ? ("));
  // aria-live の外 (section の後ろ) に置く
  assert.ok(chatArea.indexOf('aria-live="polite"') < chatArea.indexOf("<ScrollToBottomButton"));
});

test("App は sessionId と sendSeq を ChatArea へ渡す", () => {
  assert.ok(app.includes("sessionId={app.sessionId}"));
  assert.ok(app.includes("sendSeq={app.chat.sendSeq}"));
});

test("ScrollToBottomButton は最新へ戻るボタンとして読み上げられる", () => {
  const html = renderToStaticMarkup(
    createElement(ScrollToBottomButton, {
      onClick: () => {},
      className: "absolute bottom-4 left-1/2 -translate-x-1/2",
    }),
  );

  assert.ok(html.includes('type="button"'));
  assert.ok(html.includes('aria-label="最新のメッセージへ移動"'));
  // 見た目はコンポーネント側が持ち、位置は呼び出し側の layout で渡す (shadcn/no-restyle)
  assert.ok(html.includes("rounded-full"));
  assert.ok(html.includes("shadow-md"));
  assert.ok(html.includes("hover:border-accent/50"));
  assert.ok(html.includes("absolute bottom-4 left-1/2 -translate-x-1/2"));
});
