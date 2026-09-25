// タブを中クリック (PC のホイール押し込み) でも閉じられる契約を固定する。client に DOM テスト基盤が無いため、
// ボタンの判定は純関数で、配線と既定動作の抑止はソース走査で確かめる。
//   1. 閉じるのは button === 1 だけ (左クリックの選択と、右クリック・4 番目以降のボタンを混ぜない)
//   2. ハンドラはタブの箱に置く (ラベルの上でも × の上でも中クリックが届く)
//   3. down 側の既定動作を止める (Windows のオートスクロール / Linux のペーストは auxclick では止められない)
//   4. 中クリックを持たないタッチ端末のために × を残す
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isMiddleClick } from "../src/lib/fileTabs";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

/** FileTab の中だけを見る (タブバーの外に置いたハンドラでは通らないようにする) */
function fileTabSource(): string {
  const preview = read("src/components/FilePreview.tsx");
  const start = preview.indexOf("function FileTab(");
  assert.ok(start >= 0, "FileTab が無い");
  return preview.slice(start);
}

test("中クリックは button === 1 だけ", () => {
  assert.equal(isMiddleClick({ button: 1 }), true);
  for (const button of [0, 2, 3]) assert.equal(isMiddleClick({ button }), false);
});

test("タブの箱の中クリックを閉じる操作に繋ぐ", () => {
  const tab = fileTabSource();
  const box = tab.slice(0, tab.indexOf("<button")); // タブの箱 (ラベルと × はこの中にある)
  assert.match(box, /onAuxClick=\{closeOnMiddleClick\}/, "中クリックのハンドラがタブの箱に無い");
  assert.match(
    tab,
    /const closeOnMiddleClick = \(event: MouseEvent<[^>]+>\) => \{\s*if \(isMiddleClick\(event\)\) onClose\(\);/,
    "中クリック以外でも閉じる / 閉じていない",
  );
});

test("中クリックの down 側の既定動作を止める", () => {
  const tab = fileTabSource();
  assert.match(
    tab,
    /onMouseDown=\{\(event\) => \{\s*if \(isMiddleClick\(event\)\) event\.preventDefault\(\);/,
    "止めないと閉じるのと同時にオートスクロール / ペーストが走る",
  );
});

test("中クリックを持たない端末のために × を残す", () => {
  const tab = fileTabSource();
  assert.match(tab, /aria-label=\{`\$\{path\} を閉じる`\}/, "× の読み上げ名が変わった");
  assert.match(tab, /onClick=\{onClose\}/, "× の左クリックで閉じる配線が消えた");
});
