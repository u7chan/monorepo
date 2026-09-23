// 読み取り専用スキルの選択 state の持ち方を固定する。client に DOM テスト基盤が無いため、
// 実際の描画は組み立てず、選択の同一性と本文の取り直しの条件で固定する (docs/api-catalog.md)。
// ここが崩れると次のどれかになる。
//   1. 上書きされた組み込み (同名の共通行と並ぶ) を選ぶと、先に見つかった共通行の本文・版を出す
//   2. 共通スキルを開いたままファイルを編集し、同じ行を押し直しても古い本文が残る
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function pageSource(): string {
  return readFileSync(fileURLToPath(new URL("../src/components/SkillSettingsPage.tsx", import.meta.url)), "utf8");
}

test("選択は行固有の path で保持し、照合も path で行う", () => {
  const source = pageSource();
  assert.ok(source.includes("const [selectedFileSkillPath, setSelectedFileSkillPath]"), "選択を path で持っていない");
  assert.ok(
    source.includes(".find((skill) => skill.path === selectedFileSkillPath)"),
    "選択中の行の照合が path でない (同名の共通行と組み込み行を取り違える)",
  );
  assert.ok(source.includes("selectedPath={selectedFileSkillPath}"), "一覧へ選択中の path を渡していない");
});

test("同じ行を押し直しても本文を取り直す", () => {
  const source = pageSource();
  assert.ok(source.includes("setSelectedFileSkillSeq((seq) => seq + 1)"), "選択のたびに世代を進めていない");
  assert.ok(
    source.includes("key={`${selectedFileSkill.path}:${selectedFileSkillSeq}`}"),
    "本文ビューの key に選択の世代が入っていない (同じ行を押し直しても再取得されない)",
  );
});
