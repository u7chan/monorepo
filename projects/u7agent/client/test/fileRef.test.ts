// インラインコードからファイル参照を拾う matcher と、cwd 相対へ解決する純関数。
// 採否は Issue の表をそのままテストケースにする (docs/file-preview.md の採否表も同じ内容)。
import assert from "node:assert/strict";
import test from "node:test";
import { matchFileRef, resolveFileRef } from "../src/lib/fileRef";

const ACCEPTED: [input: string, path: string][] = [
  ["index.html", "index.html"],
  ["./a/b.png", "a/b.png"],
  ["a//b.png", "a/b.png"],
  ["a/./b.png", "a/b.png"],
  ["foo(bar).png", "foo(bar).png"],
  ["release..notes.md", "release..notes.md"],
  [".u7agent/uploads/3a7bfba36f/a.png", ".u7agent/uploads/3a7bfba36f/a.png"],
];

test("matcher: 採用する字面は正規化したパスを返す", () => {
  for (const [input, path] of ACCEPTED) {
    assert.equal(matchFileRef(input), path, input);
  }
});

test("matcher: 別表記は同じタブのキーになる", () => {
  assert.equal(matchFileRef("a//b.png"), matchFileRef("a/./b.png"));
  assert.equal(matchFileRef("./a/b.png"), matchFileRef("a/b.png"));
});

const REJECTED: [input: string, reason: string][] = [
  ["assets/", "末尾スラッシュ (ディレクトリ)"],
  ["localStorage", "ドット付き拡張子が無い"],
  ["node --check script.js", "空白を含むコマンド行"],
  ["v1.2.3", "拡張子が数字だけ"],
  ["https://example.com/a.html", "scheme 付き (URL)"],
  ["file:///tmp/a.html", "scheme 付き (URL)"],
  ["//host/a.png", "authority 形式"],
  ["foo.bar()", "拡張子に記号が入る"],
  ["a\u0000.png", "制御文字 (U+0000)"],
  ["a\u007f.png", "制御文字 (U+007F)"],
  ["a\u00a0b.png", "Unicode 空白 (U+00A0)"],
  ["a\u3000b.png", "Unicode 空白 (U+3000)"],
  ["a/../b.html", "親参照セグメント"],
  [".gitignore", "最終セグメントが dotfile"],
  [".env.local", "最終セグメントが dotfile"],
  ["x.", "末尾ドットのセグメント"],
  ["a.png/.", "末尾ドットのセグメント (正規化前の検査)"],
  ["a\\b.png", "バックスラッシュ"],
  ["", "空文字"],
];

test("matcher: 採用しない字面は null になる", () => {
  for (const [input, reason] of REJECTED) {
    assert.equal(matchFileRef(input), null, `${JSON.stringify(input)} (${reason})`);
  }
});

test("解決: rootCwd 前置きの絶対パスは cwd 相対になる", () => {
  const root = "/workspace";
  const cwd = "projects/u7agent";
  assert.equal(resolveFileRef("/workspace/projects/u7agent/index.html", root, cwd), "index.html");
  assert.equal(resolveFileRef("/workspace/projects/u7agent/nested/a.png", root, cwd), "nested/a.png");
  assert.equal(resolveFileRef("./index.html", root, cwd), "index.html");
  // rootCwd の末尾スラッシュは有無を問わない
  assert.equal(resolveFileRef("/workspace/projects/u7agent/index.html", `${root}/`, cwd), "index.html");
});

test("解決: cwd 外の絶対パスは null になる", () => {
  const root = "/workspace";
  const cwd = "projects/u7agent";
  assert.equal(resolveFileRef("/workspace/other/a.html", root, cwd), null, "別ディレクトリ");
  assert.equal(resolveFileRef("/workspace/.u7agent/uploads/3a7bfba36f/a.png", root, cwd), null, "添付の置き場");
  assert.equal(resolveFileRef("/workspace/a.html", root, cwd), null, "root 直下 (cwd の親)");
  assert.equal(resolveFileRef("/etc/passwd.md", root, cwd), null, "root の外");
});

test("解決: rootCwd 未取得なら絶対パスは不採用、相対は cwd 相対のまま", () => {
  assert.equal(resolveFileRef("/workspace/projects/u7agent/index.html", "", "projects/u7agent"), null);
  assert.equal(resolveFileRef("index.html", "", "projects/u7agent"), "index.html");
});

test("解決: 明示的な相対は cwd 前置きを剥がさない", () => {
  const root = "/workspace";
  const cwd = "projects/u7agent";
  assert.equal(resolveFileRef("projects/u7agent/a.html", root, cwd), "projects/u7agent/a.html");
  assert.equal(resolveFileRef(".u7agent/uploads/3a7bfba36f/a.png", root, cwd), ".u7agent/uploads/3a7bfba36f/a.png");
});

test("解決: cwd 未確定 (セッションなし) は対象外", () => {
  assert.equal(resolveFileRef("index.html", "/workspace", ""), null);
  assert.equal(resolveFileRef("/workspace/index.html", "/workspace", ""), null);
});

test("解決: matcher を通らない字面は解決しない", () => {
  assert.equal(resolveFileRef("localStorage", "/workspace", "projects/u7agent"), null);
  assert.equal(resolveFileRef("a/../b.html", "/workspace", "projects/u7agent"), null);
});
