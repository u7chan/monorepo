// サイドバーのモードとメイン領域の対応、設定ナビの項目。DOM を使わず純粋なロジックだけを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { SETTINGS_SECTIONS, mainViewFor } from "../src/lib/settingsNav";

test("settings モードでは設定ページ、nav モードではチャットをメイン領域に出す", () => {
  assert.equal(mainViewFor("settings"), "settings");
  assert.equal(mainViewFor("nav"), "chat");
});

test("設定ナビはエージェント / スキル / ファイル / 外観 の 4 項目をこの順で持つ", () => {
  assert.deepEqual(
    SETTINGS_SECTIONS.map((item) => [item.section, item.label]),
    [
      ["agents", "エージェント"],
      ["skills", "スキル"],
      ["files", "ファイル"],
      ["appearance", "外観"],
    ],
  );
});
