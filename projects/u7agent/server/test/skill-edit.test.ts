// 保存用の純粋モジュール (frontmatter 境界・source range 差し替え・no-op 判定) を実ファイルなしで固定する。
// スキルとしての意味の正は SDK なので、差し替え結果は SDK の parseFrontmatter でも読めることを確かめる。
import assert from "node:assert/strict";
import test from "node:test";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  createSkillText,
  editSkillText,
  inspectSkillText,
  skillFileVersion,
  SKILL_EDIT_BROKEN_YAML,
  SKILL_EDIT_DESCRIPTION_ANCHORED,
  SKILL_EDIT_NO_FRONTMATTER,
  SKILL_EDIT_NOT_MAP,
} from "../src/sandbox/skill-edit";

/** 編集結果を返す。失敗したテストで理由を見えるようにする */
function edited(original: string, description: string, body: string) {
  const result = editSkillText({ original, description, body });
  if (!result.ok) throw new Error(`edit failed: ${result.reason}`);
  return result;
}

const COMPLEX = [
  "---",
  "# 先頭のコメント",
  "name: alpha",
  "description: 元の説明 # 行内コメント",
  "disable-model-invocation: true",
  "x-unknown: { nested: [1, 2] }",
  "x-list:",
  "  - a",
  "  - b",
  "---",
  "  body line  ",
  "末尾の空行",
  "",
].join("\n");

test("description と本文だけを差し替え、未知キー・コメント・キー順・非表示キーを保持する", () => {
  const result = edited(COMPLEX, "新しい説明", "\n  body line  \n末尾の空行\n");
  assert.equal(result.changed, true);
  assert.equal(
    result.text,
    COMPLEX.replace("description: 元の説明 # 行内コメント", 'description: "新しい説明" # 行内コメント'),
  );
  const parsed = parseFrontmatter(result.text);
  assert.equal(parsed.frontmatter.description, "新しい説明");
  assert.equal(parsed.frontmatter.name, "alpha");
  assert.equal((parsed.frontmatter as Record<string, unknown>)["disable-model-invocation"], true);
  assert.deepEqual(parsed.frontmatter["x-unknown"], { nested: [1, 2] });
  assert.deepEqual(parsed.frontmatter["x-list"], ["a", "b"]);
  // 本文は SDK が trim して読むが、原文の前後の空白と改行は変えない
  assert.match(result.text, /\n---\n  body line  \n末尾の空行\n$/);
});

test("本文は trim せず、前後の空白をそのまま差し替える", () => {
  const original = "---\nname: a\ndescription: d\n---\n\n  keep  \n\n";
  const info = inspectSkillText(original);
  assert.equal(info.body, "\n\n  keep  \n\n");
  const result = edited(original, "d", "\n\n  keep  \n\n\n");
  assert.equal(result.text, "---\nname: a\ndescription: d\n---\n\n  keep  \n\n\n");
});

test("同じ内容の再保存は元のバイト列をそのまま返す (CRLF / BOM でも)", () => {
  const original = '\uFEFF---\r\nname: alpha\r\ndescription: "old"\r\n---\r\nbody\r\nsecond\r\n';
  const info = inspectSkillText(original);
  assert.equal(info.description, "old");
  // 本文の改行は SDK と同じ LF へ正規化して返す (値は trim しない)
  assert.equal(info.body, "\nbody\nsecond\n");
  // フォームは改行を LF へ正規化するため、LF の本文を送っても no-op にする
  const result = edited(original, "old", info.body);
  assert.equal(result.changed, false);
  assert.equal(result.text, original);
});

test("CRLF のファイルでは、変更した本文を元の改行へ寄せて未変更部分を保つ", () => {
  const original = "---\r\nname: a\r\ndescription: d\r\n---\r\nbody\r\n";
  const result = edited(original, "d", "\nline1\nline2\n");
  assert.equal(result.text, "---\r\nname: a\r\ndescription: d\r\n---\r\nline1\r\nline2\r\n");
  assert.equal(parseFrontmatter(result.text).body, "line1\nline2");
});

test("CR だけのファイルでも境界と差し替えが崩れない", () => {
  const original = "---\rname: a\rdescription: old\r---\rbody\r";
  const info = inspectSkillText(original);
  assert.equal(info.body, "\nbody\n");
  const result = edited(original, "new", "\nbody\n");
  assert.equal(result.text, '---\rname: a\rdescription: "new"\r---\rbody\r');
});

test("SDK と同じ frontmatter 境界 (閉じ行の直後は本文) を使う", () => {
  // SDK は先頭 `---` と最初の `\n---` だけを見るため、閉じ行の後ろに続く文字も本文になる
  const info = inspectSkillText("---\nname: a\ndescription: d\n----\nbody\n");
  assert.equal(info.description, "d");
  assert.equal(info.body, "-\nbody\n");
});

test("名前が無い / ディレクトリ名と違う名前でも補完せず、そのまま保持する", () => {
  const withoutName = edited("---\ndescription: d\n---\nbody\n", "d2", "\nbody\n");
  assert.equal(withoutName.text, '---\ndescription: "d2"\n---\nbody\n');
  assert.equal(inspectSkillText(withoutName.text).name, undefined);
  const mismatched = edited("---\nname: front-name\ndescription: d\n---\nbody\n", "d2", "\nbody\n");
  assert.equal(inspectSkillText(mismatched.text).name, "front-name");
});

test("変更しない長い説明 (1024 字超) と name の warning は本文だけの編集を妨げない", () => {
  const long = "x".repeat(1100);
  const original = `---\nname: Not A Valid Name\ndescription: ${long}\n---\nbody\n`;
  const result = edited(original, long, "changed\n");
  assert.equal(parseFrontmatter(result.text).frontmatter.name, "Not A Valid Name");
  assert.equal(parseFrontmatter(result.text).frontmatter.description, long);
});

test("変更した説明には trim 後の非空と 1024 字以内を要求し、値自体は trim しない", () => {
  const original = "---\ndescription: old\n---\nbody\n";
  assert.deepEqual(editSkillText({ original, description: "   ", body: "\nbody\n" }), {
    ok: false,
    reason: "説明を空にはできません",
  });
  assert.deepEqual(editSkillText({ original, description: "x".repeat(1025), body: "\nbody\n" }), {
    ok: false,
    reason: "説明は 1024 文字以内にしてください",
  });
  const padded = edited(original, "  前後に空白  ", "\nbody\n");
  assert.equal(parseFrontmatter(padded.text).frontmatter.description, "  前後に空白  ");
});

test("複雑な YAML は非破壊的に拒否する (構文不正 / マップ以外 / anchor 付き)", () => {
  assert.equal(inspectSkillText("---\ndescription: [unclosed\n---\nbody\n").reason, SKILL_EDIT_BROKEN_YAML);
  assert.equal(inspectSkillText("---\n- a\n- b\n---\nbody\n").reason, SKILL_EDIT_NOT_MAP);
  assert.equal(inspectSkillText("no frontmatter\nbody\n").reason, SKILL_EDIT_NO_FRONTMATTER);
  assert.equal(
    inspectSkillText("---\ndescription: &a hello\nother: *a\n---\nbody\n").reason,
    SKILL_EDIT_DESCRIPTION_ANCHORED,
  );
  assert.equal(
    inspectSkillText("---\ndescription: {a: 1}\n---\nbody\n").reason,
    "description の値を安全に差し替えられません",
  );
  // 重複キーは YAML として不正 (SDK も読めない)
  assert.equal(inspectSkillText("---\ndescription: a\ndescription: b\n---\nbody\n").reason, SKILL_EDIT_BROKEN_YAML);
  for (const text of [
    "---\ndescription: [unclosed\n---\nbody\n",
    "---\ndescription: &a hello\nother: *a\n---\nbody\n",
    "---\ndescription: {a: 1}\n---\nbody\n",
  ]) {
    assert.equal(editSkillText({ original: text, description: "d", body: "\nbody\n" }).ok, false);
  }
});

test("description キーが無い frontmatter には末尾の行として足す (他のキーと本文は動かさない)", () => {
  const original = "---\nname: a\n# comment\nx: 1\n---\nbody\n";
  const result = edited(original, "new", "\nbody\n");
  assert.equal(result.text, '---\nname: a\n# comment\nx: 1\ndescription: "new"\n---\nbody\n');
  const crlf = edited("---\r\nname: a\r\n---\r\nbody\r\n", "new", "\r\nbody\r\n");
  assert.equal(crlf.text, '---\r\nname: a\r\ndescription: "new"\r\n---\r\nbody\r\n');
});

test("ブロックスカラーの説明も、後ろのコメントを壊さず差し替える", () => {
  const original = "---\ndescription: |\n  hello\n  world\n# trailing comment\n---\nbody\n";
  const result = edited(original, "hi", "\nbody\n");
  assert.equal(result.text, '---\ndescription: "hi" # trailing comment\n---\nbody\n');
  assert.equal(parseFrontmatter(result.text).frontmatter.description, "hi");
  assert.equal(parseFrontmatter(result.text).body, "body");
});

test("新規は name / description の固定順・LF と安全な YAML 文字列で作り、本文を切り詰めない", () => {
  const text = createSkillText({ name: "new-skill", description: '説明 "quoted"\n\t改行', body: "line1\r\nline2" });
  assert.equal(text, '---\nname: "new-skill"\ndescription: "説明 \\"quoted\\"\\n\\t改行"\n---\nline1\nline2');
  // 本文の先頭の改行は 1 つだけ捨て、受け取った本文の意味を変えない (往復で増やさない)
  assert.equal(inspectSkillText(text).body, "\nline1\nline2");
  assert.equal(
    createSkillText({ name: "a", description: "d", body: "\nline1\nline2" }),
    text.replace("new-skill", "a").replace('description: "説明 \\"quoted\\"\\n\\t改行"', 'description: "d"'),
  );
  const parsed = parseFrontmatter(text);
  assert.equal(parsed.frontmatter.name, "new-skill");
  assert.equal(parsed.frontmatter.description, '説明 "quoted"\n\t改行');
  assert.equal(parsed.body, "line1\nline2");
  // 既存ファイルの保存経路がこの形式へ自動変換しないこと (name が無ければ足さない)
  assert.equal(inspectSkillText(text).name, "new-skill");
  assert.equal(createSkillText({ name: "a", description: "d", body: "" }), '---\nname: "a"\ndescription: "d"\n---\n');
});

test("fileVersion はバイト列の SHA-256 で、改行コードが違えば別の値になる", () => {
  assert.equal(
    skillFileVersion(Buffer.from("abc", "utf8")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.notEqual(skillFileVersion(Buffer.from("a\r\nb")), skillFileVersion(Buffer.from("a\nb")));
  // UTF-8 のマルチバイトでもバイト列で数える
  assert.notEqual(skillFileVersion(Buffer.from("あ")), skillFileVersion(Buffer.from("a")));
});
