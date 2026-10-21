// コンポーザー直上の待機ブロックの描画契約。件数・実行順・取り消しの有無・本文の見せ方を
// react-dom/server で固定する。実際の見た目 (位置・重なり・クリック) は GUI 受入で見る。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueuedSends } from "../src/components/composer/QueuedSends";
import type { QueuedSend } from "../src/lib/queueWait";

type Props = Parameters<typeof QueuedSends>[0];

const render = (props: Props): string => renderToStaticMarkup(createElement(QueuedSends, props));

const send = (sendId: string, text: string, index?: number, state: QueuedSend["state"] = "queued"): QueuedSend => ({
  sendId,
  text,
  state,
  ...(index === undefined ? {} : { index }),
});

const cancel = async (): Promise<void> => {};

test("描画: 待機が 0 件ならブロックごと出さない", () => {
  // What: 最後の 1 件が減ったときに空の見出しを残すと、件数の減少だけが読み上げられる
  assert.equal(render({ sends: [], onCancel: cancel }), "");
});

test("描画: 件数・実行順・順位をそのまま出す", () => {
  // What: 件数の正はこのブロック。順位は lib/queueWait が振り直した値をそのまま出す
  const html = render({
    sends: [send("run-1", "1 件目", 1), send("run-2", "2 件目", 2), send("run-3", "3 件目", 3)],
    onCancel: cancel,
  });

  assert.ok(html.includes("送信待ち 3 件"), "見出しに件数を出す");
  const order = ["1 件目", "2 件目", "3 件目"].map((text) => html.indexOf(text));
  assert.ok(
    order.every((index) => index >= 0),
    "全件を出す",
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    "実行順に並べる",
  );
  assert.deepEqual(
    /<li[^>]*>.*?<span[^>]*>(\d)<\/span>/gs.exec(html)?.slice(1),
    ["1"],
    "行の番号は順位の値をそのまま出す",
  );
  assert.equal((html.match(/取り消し<\/button>/g) ?? []).length, 3, "全行に取り消しを出す");
});

test("描画: 1 件だけのときは番号を出さない", () => {
  // What: 1/1 は雑音になるため、lib/queueWait が index を付けない
  const html = render({ sends: [send("run-1", "ひとつだけ")], onCancel: cancel });

  assert.ok(html.includes("送信待ち 1 件"));
  assert.ok(!/<span[^>]*>\d<\/span>/.test(html), "行の番号を出さない");
});

test("描画: 取り消しは未指定なら出さない", () => {
  // What: 取り消しの導線が無い面 (プレビュー等) でも件数と本文は読める
  const html = render({ sends: [send("run-1", "本文", 1)] });

  assert.ok(html.includes("送信待ち 1 件"));
  assert.ok(!html.includes("取り消し"), "ボタンを出さない");
});

test("描画: 本文は添付の注記とスキルブロックを除いた先頭を見せ、全文を title に持つ", () => {
  // What: バブルと同じ規則で打った文面だけを見せる。truncate は CSS なので、全文は title で読める
  const attached = "調べて\n\n<attached_files>\n- /workspace/notes.md\n</attached_files>";
  const multiline = "1 行目の本文\n2 行目の続き";
  const html = render({
    sends: [
      send("run-1", attached, 1),
      send("run-2", '<skill name="writer" location="/s/SKILL.md">\n本文\n</skill>\n\n短く書いて', 2),
      send("run-3", multiline, 3),
    ],
    onCancel: cancel,
  });

  assert.ok(html.includes(">調べて</span>"), "添付の注記を除いて本文だけを出す");
  assert.ok(html.includes('title="調べて"'), "title は注記を除いた全文");
  assert.ok(!html.includes("attached_files"), "注記はどこにも見せない");
  assert.ok(html.includes(">短く書いて</span>"), "スキルブロックを除いて引数だけを出す");
  assert.ok(html.includes(`title="${multiline}"`), "改行を含む本文も title に全文を持つ");
  assert.ok(html.includes('aria-label="「調べて」の送信を取り消す"'), "取り消しの読み上げ名にも本文の先頭を入れる");
});

test("描画: スキルだけの送信は打った /skill: の文面を見せる", () => {
  // What: 引数が空だと本文が空になるため、行が空にならないよう元の文面へ戻す
  const html = render({ sends: [send("run-1", "/skill:writer", 1)], onCancel: cancel });

  assert.ok(html.includes(">/skill:writer</span>"));
});

test("描画: 件数だけを読み上げ、行の本文はライブにしない", () => {
  // What: 本文は実行に移った時点で transcript が読み上げる。ここで読むと二重になる
  const html = render({ sends: [send("run-1", "本文", 1)], onCancel: cancel });

  assert.ok(html.includes('aria-live="polite"'), "見出しで件数の増減を伝える");
  assert.equal((html.match(/aria-live=/g) ?? []).length, 1, "ライブ領域は見出しだけ");
});

test("描画: steering の送信は反映中として見せ、取り消しを出さない", () => {
  // What: SDK が取り出した入力は取消・再送・破棄できず、反映中としてだけ見せる
  const html = render({ sends: [send("run-1", "反映待ち", 1, "steering")], onCancel: cancel });

  assert.ok(html.includes("反映中"), "反映中を示す");
  assert.ok(!html.includes("取り消し"), "取消のボタンを出さない");
});
