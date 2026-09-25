// ツリーの行を入力欄へドラッグしたときのファイル参照 (メンション)。client に DOM テスト基盤が無いため、
// 挿入規則とドラッグの判定は純関数を直接固定し、配線 (行が積むデータ / Composer の分岐の順) はソース走査で固定する。
//   1. 参照の型は OS からのファイル (`Files`) と区別し、添付より先に判定する
//   2. 挿入は前後の区切りに空白を足し、カーソルを参照の直後 (続きを書ける位置) に置く
//   3. ファイル行は参照用の型とプレーンテキストの両方を積む (他アプリへ落としたときは本文になる)
//   4. Composer は参照を添付より先に見る (逆だと `Files` を持たない参照のドロップが捨てられる)
//   5. 参照を積めるのはドロップ先と同じ画面にある desktop の右パネルだけ (compact の sheet は入力欄へ届かない)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { composerDropKind, FILE_MENTION_MIME, insertFileMention, mentionText } from "../src/lib/fileMention";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

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

test("ツリーのファイル行は参照とプレーンテキストの両方を積む", () => {
  const source = read("src/components/FileBrowser.tsx");
  assert.match(source, /event\.dataTransfer\.setData\(FILE_MENTION_MIME, path\)/);
  assert.match(source, /event\.dataTransfer\.setData\("text\/plain", mentionText\(path\)\)/);
  assert.match(source, /draggable=\{canRef\}/);
  // 参照を積めるのはドロップ先 (入力欄) と同じ画面にある面だけ。compact の sheet は modal で入力欄へ届かない
  assert.match(read("src/components/SessionFilesPanel.tsx"), /canRef=\{!compact\}/);
  assert.match(read("src/components/FileTreePage.tsx"), /<FileBrowser/);
  assert.doesNotMatch(read("src/components/FileTreePage.tsx"), /canRef/);
});

test("Composer は参照のドロップを添付より先に見る", () => {
  const source = read("src/components/Composer.tsx");
  const body = source.slice(source.indexOf("const handleDrop ="), source.indexOf("const handleSubmit ="));
  assert.ok(body.includes("composerDropKind"), "種類の判定を通す");
  assert.ok(
    body.indexOf('kind === "mention"') < body.indexOf("dataTransfer.files.length"),
    "添付より先に参照を処理する (逆だと参照のドロップが捨てられる)",
  );
  // 挿入位置はドロップ座標 (dragover で控える)、取れなければ現在の選択
  assert.match(source, /caretPositionFromPoint/);
  assert.match(source, /insertFileMention\(value, path, start, end\)/);
});
