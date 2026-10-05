// インラインコードからファイル参照を拾う matcher と、面の種別つきで解決する純関数。
// 採否は Issue の表をそのままテストケースにする (docs/file-preview.md の採否表も同じ内容)。
import assert from "node:assert/strict";
import test from "node:test";
import { matchFileRef, resolveFileRef, resolveFileRefTarget } from "../src/lib/fileRef";

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

/** 未所属チャットの作業フォルダ。共通スキルの置き場 (root 直下) とは別の座標になる */
const UNASSIGNED_CWD = ".u7agent/sessions/s1";

test("面つき解決: 共通スキルの絶対パスはスキル面の (root, path) になる", () => {
  const root = "/workspace";
  assert.deepEqual(resolveFileRefTarget(`${root}/.agents/skills/alpha/SKILL.md`, root, UNASSIGNED_CWD), {
    kind: "skill",
    root: ".agents/skills/alpha",
    path: "SKILL.md",
  });
  // 補助ファイルも SKILL.md と同じ skill dir を root にする
  assert.deepEqual(resolveFileRefTarget(`${root}/.agents/skills/alpha/assets/a.png`, root, UNASSIGNED_CWD), {
    kind: "skill",
    root: ".agents/skills/alpha",
    path: "assets/a.png",
  });
  // SKILL.md 以外の配置も開く (首尾に置ける名前は見ない)
  assert.deepEqual(resolveFileRefTarget(`${root}/.agents/skills/alpha/notes.md`, root, UNASSIGNED_CWD), {
    kind: "skill",
    root: ".agents/skills/alpha",
    path: "notes.md",
  });
  assert.deepEqual(resolveFileRefTarget(`${root}/.agents/skills/alpha/nested/deep/x.md`, root, UNASSIGNED_CWD), {
    kind: "skill",
    root: ".agents/skills/alpha",
    path: "nested/deep/x.md",
  });
});

test("面つき解決: root / path の境界はスキル名の位置で切る", () => {
  const root = "/workspace";
  // 名前は最初のセグメント 1 つ。`alpha-2` は別のスキルで、`alpha` へ混ぜない
  assert.deepEqual(resolveFileRefTarget(`${root}/.agents/skills/alpha-2/SKILL.md`, root, UNASSIGNED_CWD), {
    kind: "skill",
    root: ".agents/skills/alpha-2",
    path: "SKILL.md",
  });
  // 空セグメントは matcher の正規化後の座標で見る
  assert.deepEqual(resolveFileRefTarget(`${root}/.agents/skills/alpha/./SKILL.md`, root, UNASSIGNED_CWD), {
    kind: "skill",
    root: ".agents/skills/alpha",
    path: "SKILL.md",
  });
  // rootCwd の末尾スラッシュは有無を問わない
  assert.equal(
    resolveFileRefTarget(`${root}/.agents/skills/alpha/SKILL.md`, `${root}/`, UNASSIGNED_CWD)?.kind,
    "skill",
  );
});

test("面つき解決: 名前が取れない階層と、共通スキル以外の root 外パスは不採用", () => {
  const root = "/workspace";
  assert.equal(resolveFileRefTarget(`${root}/.agents/skills`, root, UNASSIGNED_CWD), null, ".agents/skills 直下");
  assert.equal(resolveFileRefTarget(`${root}/.agents/skills/alpha`, root, UNASSIGNED_CWD), null, "名前だけの階層");
  assert.equal(
    resolveFileRefTarget(`${root}/.agents/skillsx/alpha/SKILL.md`, root, UNASSIGNED_CWD),
    null,
    "接頭辞の別名",
  );
  assert.equal(resolveFileRefTarget(`${root}/generated/cafe.png`, root, UNASSIGNED_CWD), null, "root 直下の成果物");
  assert.equal(resolveFileRefTarget("/etc/passwd.md", root, UNASSIGNED_CWD), null, "root の外");
  // プロジェクトスキルは未所属チャットの cwd 外で、共通スキルの置き場でもない
  assert.equal(
    resolveFileRefTarget(`${root}/projects/x/.agents/skills/alpha/SKILL.md`, root, UNASSIGNED_CWD),
    null,
    "プロジェクトスキル",
  );
  assert.equal(resolveFileRefTarget(`${root}/.agents/skills/alpha/`, root, UNASSIGNED_CWD), null, "末尾スラッシュ");
  assert.equal(resolveFileRefTarget("/etc/passwd.md", "", UNASSIGNED_CWD), null, "rootCwd 未取得");
  assert.equal(resolveFileRefTarget(`${root}/.agents/skills/alpha/SKILL.md`, root, ""), null, "cwd 未確定");
});

test("面つき解決: cwd 配下の絶対パスは既存の作業フォルダ面を優先する", () => {
  const root = "/workspace";
  // プロジェクトの cwd が共通スキル配下にある場合でも、既存の採否を変えない
  assert.deepEqual(resolveFileRefTarget(`${root}/.agents/skills/alpha/SKILL.md`, root, ".agents/skills/alpha"), {
    kind: "work",
    path: "SKILL.md",
  });
  // workspace 相対の `.agents/skills/...` は cwd 相対のまま (project skill と衝突するため振り分けない)
  assert.deepEqual(resolveFileRefTarget(".agents/skills/alpha/SKILL.md", root, UNASSIGNED_CWD), {
    kind: "work",
    path: ".agents/skills/alpha/SKILL.md",
  });
  // 明示的な相対と cwd 配下の絶対パスは従来どおり
  assert.deepEqual(resolveFileRefTarget("index.html", root, "projects/u7agent"), { kind: "work", path: "index.html" });
  assert.deepEqual(resolveFileRefTarget(`${root}/projects/u7agent/a.html`, root, "projects/u7agent"), {
    kind: "work",
    path: "a.html",
  });
});
