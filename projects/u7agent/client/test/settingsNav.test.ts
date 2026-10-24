// 設定のセクション定義と、保存された「最後のセクション」の解決。DOM を使わず純粋なロジックだけを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTENT_SUBSECTIONS,
  DEFAULT_CONTENT_SUBSECTION,
  DEFAULT_FILES_SUBSECTION,
  DEFAULT_MODELS_SUBSECTION,
  DEFAULT_RUNTIME_SUBSECTION,
  DEFAULT_SETTINGS_SECTION,
  FILES_SUBSECTIONS,
  MODELS_SUBSECTIONS,
  parseStoredSettingsSection,
  RUNTIME_SUBSECTIONS,
  SETTINGS_SECTIONS,
  SHARING_SUBSECTIONS,
  DEFAULT_SHARING_SUBSECTION,
  SETTINGS_SECTION_KEY,
} from "../src/lib/settingsNav";

test("設定ナビは 12 項目をこの順で持つ", () => {
  assert.deepEqual(
    SETTINGS_SECTIONS.map((item) => [item.section, item.label]),
    [
      ["spaces", "会話スペース"],
      ["agents", "エージェント"],
      ["skills", "スキル"],
      ["models", "モデル"],
      // モデルとは対象そのものが別で、モデルのタブではなくルートのセクションに置く
      ["content", "コンテンツ生成"],
      ["web-search", "Web 検索"],
      // 会話タイトルの AI 要約は本会話のモデルとは独立の設定なので、モデルのタブにせずルートへ置く
      ["session-title", "会話タイトル"],
      ["sharing", "共有"],
      ["notifications", "通知"],
      ["appearance", "外観"],
      ["files", "ファイル"],
      ["runtime", "ランタイム"],
    ],
  );
});

test("設定 → モデルのタブは「モデルを選ぶ / プロバイダー」の 2 項目で、既定はモデルを選ぶ", () => {
  assert.deepEqual(
    MODELS_SUBSECTIONS.map((item) => [item.subsection, item.label]),
    [
      ["models", "モデルを選ぶ"],
      ["providers", "プロバイダー"],
    ],
  );
  assert.equal(DEFAULT_MODELS_SUBSECTION, MODELS_SUBSECTIONS[0].subsection);
});

test("コンテンツ生成は画像・TTS・BGMのタブを持ち、既定は画像生成", () => {
  assert.deepEqual(
    CONTENT_SUBSECTIONS.map((item) => [item.subsection, item.label]),
    [
      ["image", "画像生成"],
      ["speech", "音声（TTS）"],
      ["bgm", "音楽（BGM）"],
    ],
  );
  assert.equal(DEFAULT_CONTENT_SUBSECTION, CONTENT_SUBSECTIONS[0].subsection);
});

test("設定 → ファイルのタブは「ファイルツリー / ダウンロードの除外」の 2 項目で、既定はファイルツリー", () => {
  assert.deepEqual(
    FILES_SUBSECTIONS.map((item) => [item.subsection, item.label]),
    [
      ["files", "ファイルツリー"],
      ["archive", "ダウンロードの除外"],
    ],
  );
  assert.equal(DEFAULT_FILES_SUBSECTION, FILES_SUBSECTIONS[0].subsection);
});

test("設定 → ランタイムのタブは「サービス / 環境 / 診断」の 3 項目で、既定はサービス", () => {
  assert.deepEqual(
    RUNTIME_SUBSECTIONS.map((item) => [item.subsection, item.label]),
    [
      ["service", "サービス"],
      ["environment", "環境"],
      ["diagnostics", "診断"],
    ],
  );
  assert.equal(DEFAULT_RUNTIME_SUBSECTION, RUNTIME_SUBSECTIONS[0].subsection);
});

test("保存された最後のセクションは既知の値だけを受け、それ以外は既定へ畳む", () => {
  for (const item of SETTINGS_SECTIONS) {
    assert.equal(parseStoredSettingsSection(item.section), item.section);
  }
  assert.equal(parseStoredSettingsSection(null), DEFAULT_SETTINGS_SECTION);
  assert.equal(parseStoredSettingsSection(""), DEFAULT_SETTINGS_SECTION);
  assert.equal(parseStoredSettingsSection("nope"), DEFAULT_SETTINGS_SECTION);
  assert.equal(parseStoredSettingsSection("Files"), DEFAULT_SETTINGS_SECTION, "URL と違い保存値は厳密に見る");
  // 旧「ダウンロード」セクションはファイル画面のタブへ移したので、files へ読み替える
  assert.equal(parseStoredSettingsSection("archive"), "files");
  assert.equal(DEFAULT_SETTINGS_SECTION, "agents", "新しい項目を加えても既定の入口は変えない");
  assert.equal(SETTINGS_SECTION_KEY, "u7agent-settings-section");
});

test("設定 → 共有のタブは「共有コンテンツ / 接続」で、既定は共有コンテンツ", () => {
  assert.deepEqual(
    SHARING_SUBSECTIONS.map((item) => [item.subsection, item.label]),
    [
      ["contents", "共有コンテンツ"],
      ["connections", "接続"],
    ],
  );
  assert.equal(DEFAULT_SHARING_SUBSECTION, SHARING_SUBSECTIONS[0].subsection);
});
