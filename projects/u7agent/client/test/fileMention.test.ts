import assert from "node:assert/strict";

import test from "node:test";
import { composerDropKind, FILE_MENTION_MIME, insertFileMention, mentionText } from "../src/lib/fileMention";

test("参照は添付 (Files) と区別し、両方あるときは参照を優先する", () => {
  assert.equal(composerDropKind([FILE_MENTION_MIME]), "mention");
  assert.equal(composerDropKind([FILE_MENTION_MIME, "text/plain"]), "mention", "型は複数積まれる");
  assert.equal(composerDropKind(["Files"]), "files");
  assert.equal(composerDropKind(["Files", FILE_MENTION_MIME]), "mention");
});

test("対象外のドラッグは何もしない (既定動作を止めない)", () => {
  assert.equal(composerDropKind([]), null);
  assert.equal(composerDropKind(["text/plain"]), null);
  assert.equal(composerDropKind(["text/uri-list"]), null);
});

test("参照の字面は @ と作業フォルダ相対のパス", () => {
  assert.equal(mentionText("cafe.html"), "@cafe.html");
  assert.equal(mentionText("src/lib/foo.ts"), "@src/lib/foo.ts");
});

test("区切りの空白と紛れるパスは二重引用符で囲む", () => {
  assert.equal(mentionText("my dir/a.ts"), '@"my dir/a.ts"');
  assert.equal(mentionText("foo "), '@"foo "', "末尾の空白は区切りと区別できない");
  assert.equal(mentionText(' a"b\\c '), '@" a\\"b\\\\c "', "引用符とバックスラッシュはエスケープする");
});

test("送信時の trim を通しても参照のパスが変わらない", () => {
  // 囲まないと trim で末尾の空白が消え、別のファイル (`foo ` → `foo`) を指す
  assert.equal(insertFileMention("", "foo ", 0, 0).value.trim(), '@"foo "');
  assert.equal(insertFileMention("直して", "foo ", 3, 3).value.trim(), '直して @"foo "');
});

test("空の入力欄へ挿すと参照と区切りの空白だけになる", () => {
  assert.deepEqual(insertFileMention("", "cafe.html", 0, 0), { value: "@cafe.html ", caret: 11 });
});

test("末尾へ挿すと前に区切りを足し、続きは参照の後ろから書ける", () => {
  const result = insertFileMention("直して", "cafe.html", 3, 3);
  assert.equal(result.value, "直して @cafe.html ");
  assert.equal(result.caret, result.value.length);
});

test("既に空白がある位置には区切りを重ねない", () => {
  assert.equal(insertFileMention("直して ", "cafe.html", 4, 4).value, "直して @cafe.html ");
});

test("文中へ挿すと前後に区切りが入る", () => {
  assert.equal(insertFileMention("hello world", "a.ts", 5, 5).value, "hello @a.ts world");
});

test("選択範囲は参照で置き換える", () => {
  assert.equal(insertFileMention("hello world", "a.ts", 0, 5).value, "@a.ts world");
});

test("行頭の改行の後ろには区切りを足さない", () => {
  assert.equal(insertFileMention("line\n", "a.ts", 5, 5).value, "line\n@a.ts ");
});
