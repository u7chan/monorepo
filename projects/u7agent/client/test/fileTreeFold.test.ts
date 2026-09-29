// ファイルツリーのディレクトリの開閉 (しゅっと開く / 畳む) の契約を固定する。client に DOM テスト基盤が無く、
// 遷移の見え方そのものは自動では観測できないため、CSS の定義と FileBrowser の配線と時間の一致をソース走査で
// 突き合わせ、実際の動きは手動確認に残す (docs/file-preview.md#開閉)。どれかが崩れると次のどれかになる。
//   1. 高さが grid の行 (0fr → 1fr) 以外で動き、畳むときに内容が一瞬残る / 瞬時に閉じる
//   2. 子を潰す min-height / overflow のどちらかが落ち、遷移の途中で内容が溢れて見える
//   3. 閉じた枝の内容が DOM から消え、畳むときだけ遷移が効かない (または未取得の枝に読み込み中が残る)
//   4. 閉じた枝の行がフォーカス可能なまま残る (Tab で見えない行に入る)
//   5. prefers-reduced-motion でも動く
//   6. reveal のスクロールの合わせ直しが遷移の長さを JS に写し、CSS とずれる (または手動スクロールを巻き戻す)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

/** ファイルツリーの折りたたみの定義 (styles/index.css の @layer components) を規則ごとに切り出す */
function foldRules(): { css: string; base: string; open: string; child: string } {
  const css = read("src/styles/index.css");
  const layer = css.indexOf("@layer components");
  const baseAt = css.indexOf(".tree-fold {");
  const openAt = css.indexOf('.tree-fold[data-open="true"] {');
  const childAt = css.indexOf(".tree-fold > * {");
  assert.ok(layer >= 0, "@layer components が無い");
  assert.ok(baseAt > layer, ".tree-fold が @layer components の外にある");
  assert.ok(openAt > baseAt, ".tree-fold の開いた状態の規則が無い");
  assert.ok(childAt > openAt, ".tree-fold の子を潰す規則が無い");
  return {
    css,
    base: css.slice(baseAt, css.indexOf("}", baseAt)),
    open: css.slice(openAt, css.indexOf("}", openAt)),
    child: css.slice(childAt, css.indexOf("}", childAt)),
  };
}

test("折りたたみは grid の行 (0fr → 1fr) を遷移させ、子を潰す", () => {
  const { base, open, child } = foldRules();
  assert.ok(base.includes("display: grid;"), ".tree-fold が grid でない");
  assert.ok(base.includes("grid-template-rows: 0fr;"), "閉じた状態の行が 0fr でない");
  assert.ok(
    /transition:\s*grid-template-rows \d+ms ease-out;/.test(base),
    ".tree-fold が grid-template-rows を遷移させていない",
  );
  assert.ok(open.includes("grid-template-rows: 1fr;"), "開いた状態の行が 1fr でない");
  // どちらか片方だけだと、遷移の途中で内容の高さが残る / 溢れて見える
  assert.ok(child.includes("min-height: 0;"), ".tree-fold の子に min-height が無い");
  assert.ok(child.includes("overflow: hidden;"), ".tree-fold の子に overflow: hidden が無い");
});

test("閉じた枝も取得済みの内容を残し、閉じている入れ物は inert で外す", () => {
  const browser = read("src/components/FileBrowser.tsx");
  // 入れ物は開く前から置く (新しく mount した要素には遷移の前の値が無く、初回の開が瞬時になるため)。
  // 閉じた枝の内容を DOM に残す (畳むときも同じ遷移で潰す)
  assert.match(
    browser,
    /const loaded = node\?\.children !== undefined \|\| node\?\.error !== undefined;/,
    "一覧が届いたかの判定が無い",
  );
  // 「読み込み中…」と内容は別の入れ物にする: 同じ入れ物で入れ替えると、開き切った後の高さ (1fr の
  // 解決値) は変わっても遷移が走らず、取得の完了が飛んで見える (入れ替えは 2 つの遷移を重ねる)
  assert.match(
    browser,
    /const loadingOpen = open && !loaded;/,
    "読み込み中の行の入れ物の開閉が無い (または内容と同じ入れ物にある)",
  );
  assert.match(browser, /const contentOpen = open && loaded;/, "内容の入れ物の開閉が無い");
  // inert は「その入れ物が閉じているか」で決める。ディレクトリが開いていても、閉じた入れ物の中身は
  // 高さ 0 で見えないだけなので、フォーカスも読み上げもさせない (取得後の「読み込み中…」が残る)
  assert.match(browser, /data-open=\{loadingOpen\} inert=\{!loadingOpen\}/, "読み込み中の入れ物が inert でない");
  assert.match(browser, /data-open=\{contentOpen\} inert=\{!contentOpen\}/, "内容の入れ物が inert でない");
  // 内容は取得済みの子だけを描く (未取得の枝に中身は無い。閉じた枝は残す)
  assert.match(browser, /\{node\?\.children \? \(/, "取得済みの子を描いていない");
});

test("prefers-reduced-motion では折りたたみを遷移させない", () => {
  const css = read("src/styles/index.css");
  const childAt = css.indexOf(".tree-fold > * {");
  const media = css.indexOf("@media (prefers-reduced-motion: reduce) {", childAt);
  assert.ok(media > childAt, "折りたたみの prefers-reduced-motion の規則が無い");
  const block = css.slice(media, css.indexOf("@media", media + 1));
  assert.ok(block.includes(".tree-fold {"), "prefers-reduced-motion が .tree-fold を対象にしていない");
  assert.ok(block.includes("transition: none;"), "prefers-reduced-motion で遷移を止めていない");
});

test("reveal のスクロールの合わせ直しは、待ち時間の定数を持たず transitionend を合図にする", () => {
  const browser = read("src/components/FileBrowser.tsx");
  // 遷移の長さを JS に写すと、CSS を変えたときに黙ってずれる。合図は transitionend にする
  assert.ok(!/FOLD_MS/.test(browser), "折りたたみの長さを JS の定数に写している");
  assert.match(browser, /fold\.addEventListener\("transitionend", scrollToRow\)/, "transitionend を拾っていない");
  assert.match(browser, /event\.propertyName !== "grid-template-rows"/, "高さ以外の遷移でもスクロールし直す");
});
