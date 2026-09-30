// 生成中の活動ラベル (「考え中…」) に流す光。client に DOM テスト基盤が無いため、次の 3 つを固定する。
//   1. 見た目: styles/index.css の .activity-shimmer が @layer components の中で、
//      行の色と同じ基準色のグラデーションを文字へクリップして動かす
//   2. 無効化: prefers-reduced-motion ではグラデーションごと外して通常色へ戻し、
//      forced-colors では CanvasText に戻す (アニメーションを止めるだけでは文字が薄い / 消える)
//   3. 配線: ComposerStatus は activityState が thinking のときだけラベルに当て、
//      App は文言と由来を activityDisplay の結果から組で渡す (生の state を渡すと再試行の文言に光が当たる)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerStatus } from "../src/components/composer/ComposerStatus";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

const css = read("src/styles/index.css");

/** 位置 from 以降で最初に現れる selector の宣言ブロックを、閉じ括弧まで切り出す */
function blockAt(selector: string, from = 0): string {
  const start = css.indexOf(selector, from);
  assert.ok(start >= 0, `${selector} が無い`);
  return css.slice(start, css.indexOf("}", start) + 1);
}

const definition = css.indexOf(".activity-shimmer {");
const main = blockAt(".activity-shimmer {");
const reducedMotion = blockAt(
  ".activity-shimmer {",
  css.indexOf("@media (prefers-reduced-motion: reduce)", definition),
);

test("見た目: 光は @layer components の中で文字へクリップされる", () => {
  const layer = css.indexOf("@layer components");

  assert.ok(layer >= 0, "@layer components が無い");
  assert.ok(definition > layer, ".activity-shimmer が @layer components の外にある");
  assert.ok(main.includes("background-clip: text;"), "グラデーションが文字にクリップされない");
  assert.ok(main.includes("-webkit-text-fill-color: transparent;"), "文字色がグラデーションを隠す");
  assert.ok(main.includes("var(--c-ink-muted)") && main.includes("var(--c-ink)"), "行の色を使っていない");
  assert.ok(main.includes("background-size: 220%"), "帯が通り抜ける幅が無い");
  assert.ok(main.includes("animation: activity-shimmer-sweep 2.4s linear infinite;"), "動きが無限ループでない");
});

test("見た目: reduced-motion では動かさず、グラデーションを外して通常色へ戻す", () => {
  assert.ok(reducedMotion.includes(".activity-shimmer"), "reduced-motion の対象外");
  assert.ok(reducedMotion.includes("animation: none;"), "動きが止まらない");
  assert.ok(reducedMotion.includes("background-image: none;"), "止めただけだと帯が途中で固まる");
  assert.ok(reducedMotion.includes("color: inherit;"), "通常色へ戻していない");
});

test("見た目: forced-colors では背景画像が落ちるため通常色へ戻す", () => {
  const forcedColors = blockAt(".activity-shimmer {", css.indexOf("@media (forced-colors: active)"));

  assert.ok(forcedColors.includes("background-image: none;"), "透明のまま残ると文字が消える");
  assert.ok(forcedColors.includes("CanvasText"), "強制配色のシステム色へ戻していない");
});

test("描画: 生成中のときだけ活動ラベルへ光を当てる", () => {
  const html = (props: Parameters<typeof ComposerStatus>[0]): string =>
    renderToStaticMarkup(createElement(ComposerStatus, props));
  const runningSince = Date.now();

  assert.ok(
    html({ activity: "考え中…", activityState: "thinking", runningSince }).includes("activity-shimmer"),
    "生成中に光が流れない",
  );
  assert.ok(
    !html({ activity: "read を実行中…", activityState: "tool", runningSince }).includes("activity-shimmer"),
    "ツール実行中まで光らせている",
  );
  assert.ok(
    !html({ activity: "実行中…（タブを閉じても処理は続きます）", runningSince }).includes("activity-shimmer"),
    "由来が無い (再接続前など) のに装飾している",
  );
});

test("配線: App は activityDisplay の結果だけを Composer へ渡す", () => {
  const app = read("src/App.tsx");
  const start = app.indexOf("<Composer");
  const props = app.slice(start, app.indexOf("/>", start));

  assert.ok(app.includes("activityDisplay("), "文言と由来を組で決めていない");
  assert.ok(props.includes("activity={activity.text}"), "文言を activityDisplay の結果から渡していない");
  assert.ok(props.includes("activityState={activity.state}"), "由来を activityDisplay の結果から渡していない");
  // 生の state を渡すと、再試行の文言 (再実行の試行中は state が thinking のまま) に光が当たる。
  // helper と ComposerStatus の描画テストでは検知できないので、配線そのものをここで固定する
  assert.ok(!props.includes("app.chat.activityState"), "由来を生の state で渡している");
});
