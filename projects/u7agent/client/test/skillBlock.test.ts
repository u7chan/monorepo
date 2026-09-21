// 履歴の `<skill …>` ブロックの分解と、送信エコー照合用の正規形を DOM なしで固定する。
// 形式の正はサーバー (server/src/session-skills.ts) で、SDK の parseSkillBlock と互換。
import assert from "node:assert/strict";
import test from "node:test";
import { skillCommandForm, splitSkillBlock } from "../src/lib/skillBlock";

const fileBlock = [
  '<skill name="writer" location="/workspace/.agents/skills/writer/SKILL.md">',
  "References are relative to /workspace/.agents/skills/writer.",
  "",
  "# 書く",
  "",
  "本文です。",
  "</skill>",
].join("\n");

test("splitSkillBlock はファイル / 組み込みのブロックを分解する", () => {
  assert.deepEqual(splitSkillBlock(fileBlock), {
    name: "writer",
    location: "/workspace/.agents/skills/writer/SKILL.md",
    content: "# 書く\n\n本文です。",
  });
  // 引数は userMessage として分ける (本文には混ぜない)
  assert.deepEqual(splitSkillBlock(`${fileBlock}\n\n3 行で書いて`)?.userMessage, "3 行で書いて");
});

test("splitSkillBlock は References 行の無いカタログのブロックも受ける", () => {
  const catalog = ['<skill name="catalog-writer" location="catalog:catalog-writer">', "本文だけ", "</skill>"].join(
    "\n",
  );
  assert.deepEqual(splitSkillBlock(catalog), {
    name: "catalog-writer",
    location: "catalog:catalog-writer",
    content: "本文だけ",
  });
});

test("splitSkillBlock は対象外の本文をそのまま扱う", () => {
  // 先頭がブロックでなければ分解しない (本文中の言及は触らない)
  assert.equal(splitSkillBlock('前置き\n<skill name="x" location="/x">\n本文\n</skill>'), null);
  assert.equal(splitSkillBlock("/skill:writer"), null);
  assert.equal(splitSkillBlock("ふつうのメッセージ"), null);
  assert.equal(splitSkillBlock(""), null);
  // 本文の改行や空行はそのまま保つ
  assert.equal(
    splitSkillBlock(
      '<skill name="x" location="/x/SKILL.md">\nReferences are relative to /x.\n\n1行目\n\n3行目\n</skill>',
    )?.content,
    "1行目\n\n3行目",
  );
});

test("skillCommandForm は展開済みのブロックを打ったコマンドの形へ戻す", () => {
  assert.equal(skillCommandForm(fileBlock), "/skill:writer");
  assert.equal(skillCommandForm(`${fileBlock}\n\n3 行で書いて`), "/skill:writer 3 行で書いて");
  // ブロックでない本文と、引数の前後の空白はそのまま / trim して返す
  assert.equal(skillCommandForm("ふつうの本文"), "ふつうの本文");
  assert.equal(skillCommandForm(`${fileBlock}\n\n  余白つき  `), "/skill:writer 余白つき");
});
