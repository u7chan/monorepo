// 設定のセクション定義と、保存された「最後のセクション」の解決。DOM を使わず純粋なロジックだけを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SETTINGS_SECTION,
  parseStoredSettingsSection,
  SETTINGS_SECTIONS,
  SETTINGS_SECTION_KEY,
} from "../src/lib/settingsNav";

test("設定ナビはエージェント / スキル / ファイル / アーカイブ / 外観 / モデル / ランタイム / 通知 の 8 項目をこの順で持つ", () => {
  assert.deepEqual(
    SETTINGS_SECTIONS.map((item) => [item.section, item.label]),
    [
      ["agents", "エージェント"],
      ["skills", "スキル"],
      ["files", "ファイル"],
      // ツリーの行のダウンロード導線と対になる設定なので、ファイルの直後に置く
      ["archive", "アーカイブ"],
      ["appearance", "外観"],
      // モデルは編集する設定、ランタイムは表示専用の診断なので、編集を先に置く
      ["models", "モデル"],
      ["runtime", "ランタイム"],
      ["notifications", "通知"],
    ],
  );
});

test("保存された最後のセクションは既知の値だけを受け、それ以外は既定へ畳む", () => {
  for (const item of SETTINGS_SECTIONS) {
    assert.equal(parseStoredSettingsSection(item.section), item.section);
  }
  assert.equal(parseStoredSettingsSection(null), DEFAULT_SETTINGS_SECTION);
  assert.equal(parseStoredSettingsSection(""), DEFAULT_SETTINGS_SECTION);
  assert.equal(parseStoredSettingsSection("nope"), DEFAULT_SETTINGS_SECTION);
  assert.equal(parseStoredSettingsSection("Files"), DEFAULT_SETTINGS_SECTION, "URL と違い保存値は厳密に見る");
  assert.equal(DEFAULT_SETTINGS_SECTION, SETTINGS_SECTIONS[0].section);
  assert.equal(SETTINGS_SECTION_KEY, "u7agent-settings-section");
});
