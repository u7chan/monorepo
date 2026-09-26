// 画像のクリック拡大 (ZoomableImage) を成立させている実装を突き合わせる。どれかが崩れると、
// <p> の中に <dialog> が入って React が DOM ネストを警告する / Escape 1 回でチャットや設定まで戻る /
// <a> の中に button が入ってリンクとして動かなくなる、のどれかになる。どれも型では防げない。
// client に DOM テスト基盤が無いため、リンク内の除外は react-dom/server の描画で、dialog の扱いはソース走査で押さえる。
//   1. dialog は body へ portal し、開いている間だけ 1 つ置く (置いた場に出すと .md img の枠・角丸も拡大画像に当たる)
//   2. 開くのは showModal()。閉じるのは標準挙動 (Escape / 背景クリック / 閉じるボタン) に任せ、onClose で state を落とす
//   3. Escape の keydown は stopPropagation だけ (App の Escape へ渡さない。preventDefault すると閉じなくなる)
//   4. 背景クリックは event.target が dialog 自身のときだけ閉じる (画像や閉じるボタンのクリックで閉じない)
//   5. 見た目の切替は variant / compact が持ち、呼び出し側からは渡さない (枠・角丸・cursor・focus-visible は部品が所有)
//   6. リンクの中の画像は素の img のまま (Markdown の inLink と、生 HTML の <a> の子)
//   7. 入力欄のチップは 28px のサムネイルだけが押せる (チップ全体を押せると × と競合する)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { MarkdownView } from "../src/components/markdown/MarkdownView";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

function render(text: string): string {
  return renderToStaticMarkup(createElement(MarkdownView, { text }));
}

test("描画: 本文の画像は拡大できる button になる", () => {
  const markdown = render("![alt text](/chart.png)");
  assert.ok(markdown.includes('<button type="button"'), "Markdown 画像が button になっていない");
  assert.ok(markdown.includes('aria-label="alt text を拡大表示"'), "読み上げ名が無い");
  const html = render('<img src="/chart.png" alt="alt text">');
  assert.ok(html.includes('<button type="button"'), "生 HTML の img が button になっていない");
  // 閉じている間は dialog を置かない (portal する要素を常時 DOM に残さない)
  assert.ok(!markdown.includes("<dialog"), "開いていないのに dialog を置いている");
  assert.ok(!html.includes("<dialog"), "開いていないのに dialog を置いている");
});

test("描画: リンクの中の画像は button にせず、素の img のまま残す", () => {
  // Markdown のリンクに画像を書く 3 通り。ラベル内の Markdown 画像は解析側が画像にしないため字面のまま残る
  for (const text of ["[![alt](img.png)](https://example.com)", '[<img src="/x.png">](https://example.com)']) {
    const markdown = render(text);
    assert.ok(!markdown.includes("<button"), `${text} を button にしている`);
    assert.ok(markdown.includes("<a href="), `${text} がリンクとして描かれていない`);
  }
  // 生 HTML の <a> の中と、その入れ子 (<a><span><img></span></a>) もリンクのままにする
  for (const text of [
    '<a href="https://example.com"><img src="/y.png" alt="y"></a>',
    '<a href="https://example.com"><span><img src="/z.png"></span></a>',
  ]) {
    const markdown = render(text);
    assert.ok(!markdown.includes("<button"), `${text} を button にしている`);
    assert.ok(markdown.includes("<a href="), `${text} がリンクとして描かれていない`);
  }
});

test("ライトボックスは body へ portal し、開いている間だけ 1 つ置く", () => {
  const zoom = read("src/components/ImageZoom.tsx");
  assert.match(zoom, /\{open\s*\? createPortal\(/, "開いているときだけ portal を張る");
  const lightbox = zoom.slice(zoom.indexOf("createPortal("));
  assert.match(lightbox, /createPortal\(\s*<dialog[\s\S]*?,\s*document\.body,\s*\)/, "dialog を body へ出す");
  assert.equal(lightbox.match(/<dialog\b/g)?.length, 1, "dialog は 1 つだけ");
});

test("ライトボックスは showModal() で開き、閉じる操作は標準挙動に任せる", () => {
  const zoom = read("src/components/ImageZoom.tsx");
  assert.match(zoom, /dialog\.showModal\(\)/, "showModal() で開く (終了とフォーカス拘束は標準挙動)");
  assert.match(zoom, /event\.key === "Escape"\) event\.stopPropagation\(\);/, "Escape を親へ渡さない");
  assert.ok(!zoom.includes("preventDefault"), "preventDefault すると標準の閉じるが止まる");
  assert.match(zoom, /onClose=\{\(\) => \{\s*setOpen\(false\);/, "onClose で state を落とす");
  assert.match(zoom, /thumbRef\.current\?\.focus\(\);/, "閉じたらサムネイルへ focus を戻す");
});

test("背景クリックは dialog 自身を押したときだけ閉じる", () => {
  const zoom = read("src/components/ImageZoom.tsx");
  assert.match(zoom, /if \(event\.target === dialogRef\.current\) dialogRef\.current\?\.close\(\);/);
});

test("読み込みに失敗した画像は button で包まず、元の包含ブロックで幅を解決する", () => {
  // button は fit-content の包含ブロックなので、intrinsic 幅を持たない失敗 img を包むとサムネイルが
  // alt テキスト幅まで縮む (段落直下の img は段落幅で解決していた)。失敗したら包まずに描く
  const zoom = read("src/components/ImageZoom.tsx");
  assert.match(zoom, /const failed = failedSrc === src;/, "失敗した src を覚えておく (src が変わったら戻す)");
  assert.match(zoom, /onError=\{\(\) => setFailedSrc\(src\)\}/, "読み込み失敗を拾っていない");
  assert.match(zoom, /\{failed\s*\?\s*\(\s*thumbnail\s*\)\s*:\s*\(\s*<button/, "失敗時も button で包んでいる");
});

test("拡大画像は .md の外に置き、枠・角丸を当てない", () => {
  const zoom = read("src/components/ImageZoom.tsx");
  const lightbox = zoom.slice(zoom.indexOf("createPortal("));
  assert.match(lightbox, /<img[^>]*className="max-h-full max-w-full object-contain"/, "viewport に収まる最大で出す");
  assert.ok(!lightbox.includes("md-img"), "拡大画像に .md img の枠・角丸が当たる");
  // grid の auto 行では max-h-full が行の高さで解決されて縦長画像がはみ出す (flex なら viewport の高さで解決される)
  assert.match(
    lightbox,
    /className="m-0 flex h-dvh max-h-none w-screen max-w-none items-center justify-center border-0 bg-transparent p-0"/,
    "全画面の中央寄せを flex で組む",
  );
});

test("見た目の切替は variant / compact が持ち、呼び出し側からは渡さない", () => {
  const zoom = read("src/components/ImageZoom.tsx");
  assert.match(zoom, /variant: ImageZoomVariant;/, "variant を必須の props にする");
  assert.match(zoom, /variant === "markdown" && "md-img object-contain"/, "markdown は md-img を自分で当てる");
  assert.match(zoom, /compact \? "max-h-32" : "max-h-44"/, "添付の高さを compact で切り替える");
  const callers: [string, string][] = [
    ["src/components/chat/AttachedFiles.tsx", 'variant="attachment"'],
    ["src/components/composer/AttachmentChips.tsx", 'variant="chip"'],
    ["src/components/markdown/MarkdownView.tsx", 'variant="markdown"'],
    ["src/components/markdown/HtmlInline.tsx", 'variant="markdown"'],
  ];
  for (const [path, variant] of callers) {
    const tags = [...read(path).matchAll(/<ZoomableImage[\s\S]*?\/>/g)].map((match) => match[0]);
    assert.ok(tags.length > 0, `${path} に ZoomableImage が無い`);
    for (const tag of tags) {
      assert.ok(tag.includes(variant), `${path} が ${variant} を渡していない`);
      assert.ok(!tag.includes("className"), `${path} が className を渡している (見た目は部品が持つ)`);
    }
  }
  // compact を渡し忘れると狭い viewport でサムネイルが高くなる (型では防げない)
  assert.match(read("src/components/chat/AttachedFiles.tsx"), /compact=\{compact\}/, "添付が compact を渡していない");
});

test("チップは 28px のサムネイルだけが押せる", () => {
  const chips = read("src/components/composer/AttachmentChips.tsx");
  // thumbnail は status "done" かつ画像のときだけ入る。画像が無いチップには分岐を足さない
  assert.match(
    chips,
    /\{thumbnail \? \(\s*<ZoomableImage src=\{thumbnail\}/,
    "サムネイルを出す条件と開く条件がずれている",
  );
  assert.match(
    chips,
    /<ZoomableImage src=\{thumbnail\} alt=\{attachment\.name\} variant="chip" \/>/,
    "読み上げ名がファイル名になっていない",
  );
  assert.equal(chips.match(/<ZoomableImage\b/g)?.length, 1, "サムネイル以外からも開こうとしている");
  assert.ok(!/<li[^>]*onClick/.test(chips), "チップ全体を押せるようにしている (× と競合する)");
  const zoom = read("src/components/ImageZoom.tsx");
  assert.match(
    zoom,
    /variant === "chip" && "size-7 shrink-0 rounded object-cover"/,
    "チップ用の 28px と角丸を部品が持っていない",
  );
  assert.match(zoom, /variant === "chip" && "shrink-0 rounded"/, "押下面の角丸がサムネイルと揃っていない");
});

test("Markdown のリンク内 (inLink) は ZoomableImage を通さない", () => {
  const view = read("src/components/markdown/MarkdownView.tsx");
  const imageCase = view.slice(view.indexOf('case "image":'), view.indexOf('case "html":'));
  assert.match(imageCase, /inLink \? \(\s*<img className="md-img"[\s\S]*?\) : \(\s*<ZoomableImage/);
});

test("HtmlInline は MarkdownView から inLink を受け取り、HTML の子へ伝搬する", () => {
  // Markdown のリンクはラベルに生 HTML を書ける ([<img src="…">](url)) ため、HtmlInline の a の子だけを
  // 見ても <a> の中の button は防げない。Markdown 側の印も受けて伝搬させる
  assert.match(
    read("src/components/markdown/MarkdownView.tsx"),
    /<HtmlInline node=\{node\.node\} inLink=\{inLink\} \/>/,
    "MarkdownView が inLink を渡していない",
  );
  const html = read("src/components/markdown/HtmlInline.tsx");
  assert.match(html, /export function HtmlInline\(\{ node, inLink = false \}/, "inLink を受けていない");
  assert.match(html, /const link = inLink \|\| tag === "a";/, "a の子へ印を付けていない");
  assert.match(html, /const content = renderNodes\(children, link\);/, "子へ印を伝搬していない");
  const imgCase = html.slice(html.indexOf('case "img":'), html.indexOf("default:"));
  assert.match(imgCase, /inLink \? \(\s*<img className="md-img"[\s\S]*?\) : \(\s*<ZoomableImage/);
});
