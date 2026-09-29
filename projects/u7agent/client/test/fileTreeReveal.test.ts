// ファイルツリーの reveal (祖先を開いてスクロール + 一時ハイライト) と、プレビューのパンくずの配線を
// 突き合わせる。client に DOM テスト基盤が無いため、構造と配線をソース走査 + react-dom/server で固定し、
// 実ブラウザーでのスクロール / ハイライトの見え方は手動確認に残す (docs/file-preview.md#ツリーの-reveal)。
//   1. ファイル参照の適用時に祖先を openFileTreeAncestors で開き、対象の行を reveal する
//   2. 対象の行だけが ref を持ち、スクロールのあとに一時ハイライトを付けて消す (タイマーは unmount で掃除)
//   3. パンくずは画面 root の前置きと各階層を並べ、クリックで画面 root 相対のパスを onReveal へ渡す
//   4. パンくずの表示は root 前置き (fetchPath) を保ち、画面 root 自体はクリックできない
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

// FileBrowser / FilePreview は api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { FileBreadcrumb } = await import("../src/components/FilePreview");

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

test("ファイル参照から開いたファイルは、祖先を開いてツリーで位置を示す", () => {
  const browser = read("src/components/FileBrowser.tsx");
  // 祖先を開くのは純関数の遷移にする (取得は既存の pendingFileTreeDirectories の経路が親から順に拾う)
  assert.match(browser, /setTree\(\(prev\) => openFileTreeAncestors\(prev, path\)\)/, "祖先を開いていない");
  // 参照の適用とパンくずの両方が同じ revealRow を通る (片方だけ展開 / 片方だけ無反応にしない)
  const openEffect = browser.slice(
    browser.indexOf("// ファイル参照からの要求は mount 後の effect"),
    browser.indexOf("// 未取得のディレクトリを表示順に取得する"),
  );
  assert.match(openEffect, /revealRow\(openRequest\.path\)/, "参照の適用時に reveal していない");
  assert.match(browser, /onReveal=\{revealRow\}/, "パンくずが revealRow に繋がっていない");
});

test("reveal は行が現れてからスクロールし、一時ハイライトを付けて消す", () => {
  const browser = read("src/components/FileBrowser.tsx");
  // 祖先の取得中は対象の行が無いので、tree が進むたびに再実行して取りこぼさない (スクロール済みは弾く)
  assert.match(
    browser,
    /if \(reveal === null \|\| revealedSeqRef\.current === reveal\.seq\) return;/,
    "スクロール済みの対象を弾いていない",
  );
  assert.match(browser, /row\.scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\)/, "スクロールしていない");
  assert.match(
    browser,
    /setReveal\(\(current\) => \(current\?\.seq === reveal\.seq \? null : current\)\)/,
    "ハイライトを消していない",
  );
  // 対象の行だけが ref とハイライトを持つ (ディレクトリ行とファイル行の両方)
  assert.equal(
    (browser.match(/ref=\{revealed \? revealRef : undefined\}/g) ?? []).length,
    2,
    "行に reveal の ref が付いていない",
  );
  assert.equal(
    (browser.match(/revealed && "ring-2 ring-focus ring-inset"/g) ?? []).length,
    2,
    "行に一時ハイライトが付いていない",
  );
  // ハイライトのタイマーは unmount 後の setState を起こさないよう掃除する
  assert.match(browser, /\(\) => \(\) => \{/, "unmount の掃除が無い");
  assert.ok(
    (browser.match(/window\.clearTimeout\(revealTimerRef\.current\)/g) ?? []).length >= 2,
    "タイマーを掛け直しと unmount の両方で消していない",
  );
});

test("パンくずは root 前置きと各階層を並べ、root 相対のパスで reveal できる", () => {
  const html = renderToStaticMarkup(
    createElement(FileBreadcrumb, {
      rootPath: "projects/u7agent",
      activePath: "client/src/a.ts",
      onReveal: () => {},
    }),
  );
  assert.ok(html.includes('aria-label="ファイルの場所"'), "パンくずのラベルが無い");
  // 画面 root の前置きは表示するが、ツリーにその行は無いのでクリックできない
  assert.ok(html.includes(">projects/u7agent<"), "root 前置きの表示が無い");
  assert.ok(!html.includes('title="projects/u7agent をツリーで表示"'), "画面 root をクリックできる");
  // 画面 root 相対の祖先とファイルは、ツリーで位置を示すボタンにする
  for (const path of ["client", "client/src", "client/src/a.ts"]) {
    assert.ok(html.includes(`title="${path} をツリーで表示"`), `${path} の reveal ボタンが無い`);
  }
  assert.ok(html.includes('aria-current="page"'), "表示中のファイルを現在の位置として示していない");
  assert.ok(html.includes(">client<") && html.includes(">src<") && html.includes(">a.ts<"), "セグメントが表示されない");
});

test("パンくずのクリックと中継は画面 root 相対のパスのままにする", () => {
  const preview = read("src/components/FilePreview.tsx");
  // 表示用の fetchPath ではなく、ツリーと同じ画面 root 相対の項目パスを渡す (再ルートはしない)
  assert.match(preview, /onClick=\{\(\) => onReveal\(path\)\}/, "クリックが項目パスを渡していない");
  assert.match(
    preview,
    /<FileBreadcrumb rootPath=\{rootPath\} activePath=\{activePath\} onReveal=\{onReveal\} \/>/,
    "FilePreview がパンくずに onReveal を渡していない",
  );
});

test("reveal のスクロールの合わせ直しは、遷移が走った枝だけを対象にする", () => {
  const browser = read("src/components/FileBrowser.tsx");
  // 祖先が既に開いていれば遷移は走らない。長さで無条件に合わせ直すと直後の手動スクロールを巻き戻すため、
  // 行の祖先の折りたたみ (transitionend) を合図にする
  assert.match(browser, /el\.classList\.contains\("tree-fold"\)/, "行の祖先の折りたたみを拾っていない");
  assert.match(browser, /fold\.addEventListener\("transitionend", scrollToRow\)/, "transitionend を拾っていない");
  assert.match(browser, /fold\.removeEventListener\("transitionend", scrollToRow\)/, "listener を片付けていない");
});
