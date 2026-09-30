// native popover のパネル (スキル一覧 / ⋯ メニュー / エージェント・モデルのピッカー) の出入りの契約を固定する。
// client に DOM テスト基盤が無く、transition の見え方そのものは自動では観測できないため、CSS の定義と 4 つの
// パネルの配線をソース走査で突き合わせ、実際の動きは手動確認に残す (docs/ui-layout.md#popover-の出入り)。
//   1. 開始フレームが scale を使い、place() の getBoundingClientRect() の高さへ乗って位置が数 px ずれる
//   2. display / overlay の離散遷移が落ち、閉じるアニメーションが出ない (または @starting-style が無く開く方も出ない)
//   3. .popover-panel が display の値を持ち、UA の「閉じている間は display: none」を打ち消す
//   4. prefers-reduced-motion でも動く
//   5. 4 つのパネルのどれかが .popover-panel を落とす (そこだけ瞬時に開く)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/** .popover-panel を当てるパネル (native popover="auto" を持つ 4 つ) */
const PANELS = [
  "src/components/composer/SkillPicker.tsx",
  "src/components/composer/AgentPicker.tsx",
  "src/components/RowMenu.tsx",
  "src/components/model-settings/ModelDefaultPicker.tsx",
] as const;

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

/** styles/index.css の .popover-panel の規則 (@layer components) を規則ごとに切り出す */
function popoverRules(): { base: string; open: string; starting: string; reduceMotion: string } {
  const css = read("src/styles/index.css");
  const layer = css.indexOf("@layer components");
  const baseAt = css.indexOf(".popover-panel {");
  const openAt = css.indexOf(".popover-panel:popover-open {");
  const startingAt = css.indexOf("@starting-style {");
  const mediaAt = css.indexOf("@media (prefers-reduced-motion: reduce) {", openAt);
  assert.ok(layer >= 0, "@layer components が無い");
  assert.ok(baseAt > layer, ".popover-panel が @layer components の外にある");
  assert.ok(openAt > baseAt, ".popover-panel:popover-open の規則が無い");
  assert.ok(startingAt > openAt, "@starting-style の規則が無い");
  assert.ok(mediaAt > openAt, ".popover-panel の prefers-reduced-motion の規則が無い");
  const startingSelector = css.indexOf(".popover-panel:popover-open {", startingAt);
  return {
    base: css.slice(baseAt, css.indexOf("}", baseAt)),
    open: css.slice(openAt, css.indexOf("}", openAt)),
    starting: css.slice(startingAt, css.indexOf("}", startingSelector)),
    reduceMotion: css.slice(mediaAt, css.indexOf("@media", mediaAt + 1)),
  };
}

test("popover は opacity と translate で出入りし、scale を使わない", () => {
  const { base, open, starting } = popoverRules();
  // 閉じた状態は UA の display: none で見えないが、閉じる遷移の到達先はこの値になる
  assert.ok(base.includes("opacity: 0;"), "閉じた状態の opacity が 0 でない");
  assert.ok(base.includes("transform: translateY(4px);"), "開始フレームのずらしが translate でない");
  assert.ok(open.includes("opacity: 1;"), "開いた状態の opacity が 1 でない");
  assert.ok(open.includes("transform: translateY(0);"), "開いた状態のずらしが 0 でない");
  // 開始フレームは @starting-style が持つ (要素が描画されていないときの遷移の前の値)
  assert.ok(starting.includes("opacity: 0;"), "@starting-style の opacity が 0 でない");
  assert.ok(starting.includes("transform: translateY(4px);"), "@starting-style のずらしが translate でない");
  // scale は rect の高さに乗るため、開いた直後の getBoundingClientRect() で測る top が数 px ずれる
  assert.ok(!/scale/.test(base + open + starting), "開始フレームに scale を使っている");
});

test("display / overlay の離散遷移で、閉じる間も描画を残す", () => {
  const { base } = popoverRules();
  assert.match(
    base,
    /transition:\s*opacity \d+ms [^,]+,\s*transform \d+ms [^,]+,\s*display \d+ms [^,]+ allow-discrete,\s*overlay \d+ms [^,]+ allow-discrete;/,
    "display / overlay の allow-discrete 遷移が無い",
  );
  // display は遷移のプロパティとしてだけ書く (値を持つユーティリティを当てると UA の display: none が消える)
  assert.ok(!base.includes("display:"), ".popover-panel が display の値を持っている");
});

test("prefers-reduced-motion では popover を遷移させない", () => {
  const { reduceMotion } = popoverRules();
  assert.ok(reduceMotion.includes(".popover-panel {"), "prefers-reduced-motion が .popover-panel を対象にしていない");
  assert.ok(reduceMotion.includes("transition: none;"), "prefers-reduced-motion で遷移を止めていない");
});

test("native popover の 4 つのパネルが .popover-panel を持つ", () => {
  for (const panel of PANELS) {
    const source = read(panel);
    assert.ok(source.includes('popover="auto"'), `${panel} に popover="auto" のパネルが無い`);
    const classes = [...source.matchAll(/className="([^"]*popover-panel[^"]*)"/g)].map((match) => match[1]);
    assert.equal(classes.length, 1, `${panel} の .popover-panel の当て方が 1 箇所でない`);
    // 位置は place() が fixed の left / top を直接書く。position が static だと座標が viewport 基準にならない
    assert.ok(classes[0].includes("fixed"), `${panel} のパネルが fixed でない`);
  }
});
