// レイアウトモード判定の回帰テスト。実機で確認した代表 viewport で境界を固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_MIN_HEIGHT,
  DESKTOP_MIN_WIDTH,
  resolveLayoutMode,
  resolveSidebarPlacement,
  SIDEBAR_OVERLAY_WIDTH,
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

test("compact は幅に関係なく常に overlay (導線は CompactBar の ☰)", () => {
  assert.equal(resolveSidebarPlacement(390, "portrait"), "overlay");
  assert.equal(resolveSidebarPlacement(844, "landscape"), "overlay");
  // 幅だけを見ると docked の帯でも、モードが compact なら overlay
  assert.equal(resolveSidebarPlacement(1440, "landscape"), "overlay");
  assert.equal(resolveSidebarPlacement(1920, "portrait"), "overlay");
});
