// レイアウトモード判定の回帰テスト。実機で確認した代表 viewport で境界を固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVITY_DOCKED_MIN_WIDTH,
  DESKTOP_MIN_HEIGHT,
  DESKTOP_MIN_WIDTH,
  resolveActivitySidebarPlacement,
  resolveLayoutMode,
  resolveSidebarPlacement,
  resolveWide,
  SIDEBAR_OVERLAY_WIDTH,
  WIDE_MIN_WIDTH,
} from "../src/lib/layout";

test("幅と高さが十分なときは desktop になる", () => {
  assert.equal(resolveLayoutMode(1440, 900), "desktop");
  assert.equal(resolveLayoutMode(1024, 768), "desktop");
  // 境界は >= で判定する
  assert.equal(resolveLayoutMode(DESKTOP_MIN_WIDTH, DESKTOP_MIN_HEIGHT), "desktop");
});

test("高さが足りないときは幅があっても landscape になる", () => {
  // iPhone 14 / 15 の横向き
  assert.equal(resolveLayoutMode(844, 390), "landscape");
  // iPhone 15 Pro Max の横向き
  assert.equal(resolveLayoutMode(932, 430), "landscape");
  // 低いウィンドウも同じ扱いにする
  assert.equal(resolveLayoutMode(1440, DESKTOP_MIN_HEIGHT - 1), "landscape");
  assert.equal(resolveLayoutMode(DESKTOP_MIN_WIDTH - 1, DESKTOP_MIN_HEIGHT - 1), "landscape");
});

test("幅が足りず高さがあるときは portrait になる", () => {
  // iPhone 14 / 15 の縦向き
  assert.equal(resolveLayoutMode(390, 844), "portrait");
  assert.equal(resolveLayoutMode(412, 915), "portrait");
  assert.equal(resolveLayoutMode(320, 568), "portrait");
  assert.equal(resolveLayoutMode(DESKTOP_MIN_WIDTH - 1, DESKTOP_MIN_HEIGHT), "portrait");
});

test("desktop は 1200px 未満で左バーを overlay へ退避する", () => {
  assert.equal(resolveSidebarPlacement(SIDEBAR_OVERLAY_WIDTH, "desktop"), "docked");
  assert.equal(resolveSidebarPlacement(SIDEBAR_OVERLAY_WIDTH - 1, "desktop"), "overlay");
  // 1440x900 は従来どおり docked、desktop の最小幅は overlay
  assert.equal(resolveSidebarPlacement(1440, "desktop"), "docked");
  assert.equal(resolveSidebarPlacement(1280, "desktop"), "docked");
  assert.equal(resolveSidebarPlacement(1199, "desktop"), "overlay");
  assert.equal(resolveSidebarPlacement(1118, "desktop"), "overlay");
  assert.equal(resolveSidebarPlacement(720, "desktop"), "overlay");
});

test("singleColumn は幅に関係なく常に overlay (導線は SingleColumnBar の ☰)", () => {
  assert.equal(resolveSidebarPlacement(390, "portrait"), "overlay");
  assert.equal(resolveSidebarPlacement(844, "landscape"), "overlay");
  // 幅だけを見ると docked の帯でも、モードが singleColumn なら overlay
  assert.equal(resolveSidebarPlacement(1440, "landscape"), "overlay");
  assert.equal(resolveSidebarPlacement(1920, "portrait"), "overlay");
});

test("一覧と編集面を並べる境界は 900px (resolveWide)", () => {
  // 2048x1180 / 1300x900 は並べる。境界は >= で、CSS の --breakpoint-wide と同じ値
  assert.equal(WIDE_MIN_WIDTH, 900);
  assert.equal(resolveWide(WIDE_MIN_WIDTH), true);
  assert.equal(resolveWide(1440), true);
  assert.equal(resolveWide(WIDE_MIN_WIDTH - 1), false);
  // 狭い desktop と singleColumn は一覧ページ + 全画面シートにする
  assert.equal(resolveWide(899), false);
  assert.equal(resolveWide(820), false);
  assert.equal(resolveWide(390), false);
});

test("実行状況は 901px 以上で docked、641–900px と singleColumn は overlay", () => {
  // チャットの 1200px 判定より広い帯でも docked にする (Issue / docs の 901px 境界)
  assert.equal(ACTIVITY_DOCKED_MIN_WIDTH, 901);
  assert.equal(resolveActivitySidebarPlacement(900, "desktop"), "overlay");
  assert.equal(resolveActivitySidebarPlacement(901, "desktop"), "docked");
  assert.equal(resolveActivitySidebarPlacement(1024, "desktop"), "docked");
  assert.equal(resolveActivitySidebarPlacement(834, "desktop"), "overlay");
  assert.equal(resolveActivitySidebarPlacement(640, "desktop"), "overlay");
  // チャットの判定は変えない (同じ 1024px でも overlay)
  assert.equal(resolveSidebarPlacement(1024, "desktop"), "overlay");
  // singleColumn は幅に関係なく overlay (44px のタップ領域を当てる帯)
  assert.equal(resolveActivitySidebarPlacement(1440, "landscape"), "overlay");
  assert.equal(resolveActivitySidebarPlacement(1920, "portrait"), "overlay");
});
