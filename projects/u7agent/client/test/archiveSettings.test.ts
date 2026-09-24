// アーカイブの除外名の下書きと検証（client/src/lib/archiveSettings.ts）。DOM を使わず純ロジックだけを固定する。
// ここが崩れると、既定の一覧をそのまま保存してしまう（上書きの固定）/ 不正名を PUT する / 上限を超える。
import assert from "node:assert/strict";
import test from "node:test";
import {
  addExcludeName,
  archiveSettingsDirty,
  draftFromSettings,
  EMPTY_ARCHIVE_DRAFT,
  removeExcludeName,
  validateExcludeName,
  validateExcludeNames,
} from "../src/lib/archiveSettings";
import type { ArchiveSettingsResponse } from "../src/types";

const DEFAULTS = ["node_modules", ".venv", "dist"];

function settings(overrides: Partial<ArchiveSettingsResponse> = {}): ArchiveSettingsResponse {
  return {
    excludeNames: [...DEFAULTS],
    defaultExcludeNames: [...DEFAULTS],
    overridden: false,
    maxNames: 100,
    maxNameLength: 200,
    ...overrides,
  };
}

test("下書きは保存済みの実効値から作り、配列を共有しない", () => {
  assert.deepEqual(draftFromSettings(null), EMPTY_ARCHIVE_DRAFT);
  const source = settings();
  const draft = draftFromSettings(source);
  assert.deepEqual(draft.excludeNames, DEFAULTS);
  // 下書きを書き換えても設定は壊れない
  draft.excludeNames.push("vendor");
  assert.deepEqual(source.excludeNames, DEFAULTS);
  // 明示空のときも空で始まる
  assert.deepEqual(draftFromSettings(settings({ excludeNames: [], overridden: true })), { excludeNames: [] });
});

test("dirty は実効値との比較で決める（未設定のまま既定を保存させない）", () => {
  const saved = settings();
  assert.equal(archiveSettingsDirty(draftFromSettings(saved), saved), false);
  // 未設定でも、実効値と同じなら保存する必要は無い
  assert.equal(archiveSettingsDirty({ excludeNames: [...DEFAULTS] }, saved), false);
  // 追加 / 削除 / 並べ替えは差分
  assert.equal(archiveSettingsDirty({ excludeNames: [...DEFAULTS, "vendor"] }, saved), true);
  assert.equal(archiveSettingsDirty({ excludeNames: DEFAULTS.slice(1) }, saved), true);
  assert.equal(archiveSettingsDirty({ excludeNames: [...DEFAULTS].reverse() }, saved), true);
  // 明示空と未設定（既定）は別の状態なので差分
  assert.equal(archiveSettingsDirty({ excludeNames: [] }, saved), true);
  assert.equal(archiveSettingsDirty({ excludeNames: [] }, settings({ excludeNames: [], overridden: true })), false);
  // 読み込み前は保存できない
  assert.equal(archiveSettingsDirty({ excludeNames: ["dist"] }, null), false);
});

test("追加は trim / 空 / 重複 / 上限を扱い、順序を保つ", () => {
  const draft = { excludeNames: ["dist"] };
  assert.deepEqual(addExcludeName(draft, " vendor ", 100), { excludeNames: ["dist", "vendor"] });
  // 空と空白だけは何もしない（同じ object を返す = 画面が入力を残せる）
  assert.equal(addExcludeName(draft, "", 100), draft);
  assert.equal(addExcludeName(draft, "   ", 100), draft);
  // 重複は先勝ちで畳む（大文字小文字は別の名前として扱う）
  assert.equal(addExcludeName(draft, "dist", 100), draft);
  assert.deepEqual(addExcludeName(draft, "Dist", 100), { excludeNames: ["dist", "Dist"] });
  // 上限に達したら追加しない
  assert.equal(addExcludeName(draft, "vendor", 1), draft);
  assert.deepEqual(addExcludeName(draft, "vendor", 2), { excludeNames: ["dist", "vendor"] });
});

test("削除は一致する名前だけを落とし、無い名前では何も変えない", () => {
  const draft = { excludeNames: ["dist", "vendor", "dist"] };
  assert.deepEqual(removeExcludeName(draft, "vendor"), { excludeNames: ["dist", "dist"] });
  assert.deepEqual(removeExcludeName(draft, "missing"), draft);
});

test("検証はサーバーと同じ 1 セグメント名の規則を使う", () => {
  for (const name of ["node_modules", ".git", "日本語 名前", "x".repeat(200)]) {
    assert.equal(validateExcludeName(name, 200), undefined, name);
  }
  for (const name of ["", ".", "..", "a/b", "a\\b", "a\u0000b", "a\u001fb", "a\u007fb", "x".repeat(201)]) {
    assert.equal(
      validateExcludeName(name, 200),
      `除外名に使えない名前があります: ${name || "（空）"}`,
      JSON.stringify(name),
    );
  }
});

test("一覧の検証は件数を見てから最初の不正名で止める", () => {
  assert.equal(validateExcludeNames({ excludeNames: ["dist", "vendor"] }, 100, 200), undefined);
  assert.equal(validateExcludeNames({ excludeNames: [] }, 100, 200), undefined);
  // 件数の上限が先（どの名前が悪いかより、そもそも多すぎることを伝える）
  assert.equal(validateExcludeNames({ excludeNames: ["a/b", "c/d"] }, 1, 200), "除外名は 1 件までです");
  assert.equal(
    validateExcludeNames({ excludeNames: ["ok", "a/b", "c/d"] }, 100, 200),
    "除外名に使えない名前があります: a/b",
  );
});
