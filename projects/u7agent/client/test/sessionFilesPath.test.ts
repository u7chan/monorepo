// 作業フォルダ面の帯に出すパスの分割・絶対パス・⋯ の出し分け (純関数) と、その描画の公開状態 (SSR)。
// 帯の段の分かれ方 (幅) は browser のレイアウトでしか決まらないため、必要幅の計算までを固定し、
// 実際の折り返しは docs/testing.md の手動チェックで確認する。
import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import {
  splitWorkFolderPath,
  workFolderAbsolutePath,
  workFolderMenu,
  workFolderPathMinWidth,
  WORK_FOLDER_ABSOLUTE_MISSING,
  WORK_FOLDER_SESSION_MISSING,
} from "../src/lib/sessionFilesPath";

const { WorkFolderPathMenu } = await import("../src/components/WorkFolderPathMenu");

const SESSION_ID = "0123456789";

test("分割: 未所属は最後の 2 段 (sessions/<id>) を末尾に残し、前置きだけを省略させる", () => {
  assert.deepEqual(splitWorkFolderPath(`.u7agent/sessions/${SESSION_ID}`, false), {
    prefix: ".u7agent",
    tail: `/sessions/${SESSION_ID}`,
  });
  // 追加スペースも固定形式 (spaces/space-<16 hex>) で、末尾の 2 段は同じ形になる
  assert.deepEqual(splitWorkFolderPath(`.u7agent/spaces/space-0123456789abcdef/sessions/${SESSION_ID}`, false), {
    prefix: ".u7agent/spaces/space-0123456789abcdef",
    tail: `/sessions/${SESSION_ID}`,
  });
});

test("分割: プロジェクト所属は最後の 1 段 (登録ディレクトリ名) を末尾に残す", () => {
  assert.deepEqual(splitWorkFolderPath("projects/foo", true), { prefix: "projects", tail: "/foo" });
  // 未取得 (undefined) はプロジェクト相当の 1 段に倒す
  assert.deepEqual(splitWorkFolderPath("projects/foo", undefined), { prefix: "projects", tail: "/foo" });
  assert.deepEqual(splitWorkFolderPath("projects/foo", false), { prefix: "", tail: "projects/foo" });
});

test("分割: 末尾の /・root の .・1 段だけのパスでも前置きと末尾を壊さない", () => {
  assert.deepEqual(splitWorkFolderPath(`.u7agent/sessions/${SESSION_ID}/`, false), {
    prefix: ".u7agent",
    tail: `/sessions/${SESSION_ID}`,
  });
  // root が "." の面 (ワークスペース root) は前置きを持たない
  assert.deepEqual(splitWorkFolderPath(".", true), { prefix: "", tail: "." });
  assert.deepEqual(splitWorkFolderPath(".", false), { prefix: "", tail: "." });
  assert.deepEqual(splitWorkFolderPath("foo", true), { prefix: "", tail: "foo" });
  assert.deepEqual(splitWorkFolderPath("foo", false), { prefix: "", tail: "foo" });
  // 空の root (cwd 未確定) でも落ちない
  assert.deepEqual(splitWorkFolderPath("", false), { prefix: "", tail: "" });
});

test("絶対パス: root が . のときは rootCwd をそのまま使い、/workspace/. を出さない", () => {
  assert.equal(workFolderAbsolutePath("/workspace", "."), "/workspace");
  // 末尾の区切りは畳むが、ファイルシステムの root は "/" のまま残す
  assert.equal(workFolderAbsolutePath("/workspace/", "."), "/workspace");
  assert.equal(workFolderAbsolutePath("/", "."), "/");
  // root が配下のときは行の「絶対パスをコピー」と同じ組み立てになる
  assert.equal(workFolderAbsolutePath("/workspace", "projects/foo"), "/workspace/projects/foo");
  assert.equal(
    workFolderAbsolutePath("/srv/workspace", `.u7agent/sessions/${SESSION_ID}/`),
    `/srv/workspace/.u7agent/sessions/${SESSION_ID}`,
  );
});

test("絶対パス: rootCwd 未取得・相対の rootCwd では別の値で代替せず undefined にする", () => {
  assert.equal(workFolderAbsolutePath(undefined, "."), undefined);
  assert.equal(workFolderAbsolutePath("", "."), undefined);
  assert.equal(workFolderAbsolutePath("workspace", "."), undefined);
});

test("⋯: セッション ID → 絶対パスの順に 2 項目を出し、取れない値だけ disabled + 理由にする", () => {
  const both = workFolderMenu({ sessionId: SESSION_ID, absolutePath: "/workspace/projects/foo" });
  assert.equal(both.menu, true);
  assert.deepEqual(both.reasons, []);
  assert.deepEqual(both.actions, [
    { kind: "copy-session-id", label: "セッション ID をコピー" },
    { kind: "copy-absolute-path", label: "絶対パスをコピー" },
  ]);

  // プロジェクト起点の新規会話 (会話がまだ無い)。項目は隠さず、理由を 2 行目へ出す
  assert.deepEqual(workFolderMenu({ sessionId: "", absolutePath: "/workspace/projects/foo" }).actions, [
    {
      kind: "copy-session-id",
      label: "セッション ID をコピー",
      description: WORK_FOLDER_SESSION_MISSING,
      disabled: true,
    },
    { kind: "copy-absolute-path", label: "絶対パスをコピー" },
  ]);

  // health 未取得。絶対パスの項目だけを disabled にする
  assert.deepEqual(workFolderMenu({ sessionId: SESSION_ID, absolutePath: undefined }).actions, [
    { kind: "copy-session-id", label: "セッション ID をコピー" },
    {
      kind: "copy-absolute-path",
      label: "絶対パスをコピー",
      description: WORK_FOLDER_ABSOLUTE_MISSING,
      disabled: true,
    },
  ]);
});

test("⋯: 両方取れないときはメニューを出さず、理由を常設する (全 disabled を RowMenu へ渡さない)", () => {
  const none = workFolderMenu({ sessionId: undefined, absolutePath: undefined });
  assert.equal(none.menu, false);
  assert.deepEqual(none.actions, []);
  assert.deepEqual(none.reasons, [WORK_FOLDER_SESSION_MISSING, WORK_FOLDER_ABSOLUTE_MISSING]);
  // 空文字の sessionId も「無い」と同じ扱いにする
  assert.equal(workFolderMenu({ sessionId: "" }).menu, false);
});

test("必要幅: 末尾と ⋯ と間隔の合計を切り上げ、負の値は 0 にする", () => {
  assert.equal(workFolderPathMinWidth({ tail: 120.4, menu: 24, gap: 6 }), 151);
  assert.equal(workFolderPathMinWidth({ tail: 0, menu: 0, gap: 0 }), 0);
});

function renderMenu(props: Omit<Parameters<typeof WorkFolderPathMenu>[0], "onRequiredWidth">): string {
  return renderToStaticMarkup(createElement(WorkFolderPathMenu, { onRequiredWidth: () => {}, ...props }));
}

test("描画: パスを前置きと末尾に分け、末尾 (セッション ID) を全文のまま出す", () => {
  const html = renderMenu({
    root: `.u7agent/sessions/${SESSION_ID}`,
    absolutePath: `/workspace/.u7agent/sessions/${SESSION_ID}`,
    sessionId: SESSION_ID,
    projectSession: false,
  });
  assert.ok(html.includes(`sessions/${SESSION_ID}`), "末尾のセッション ID が出ていない");
  assert.ok(html.includes(".u7agent"), "前置きが出ていない");
  assert.ok(html.includes(`title=".u7agent/sessions/${SESSION_ID}"`), "全文の title が消えている");
  // 項目の並びは セッション ID → 絶対パス
  const sessionIdAt = html.indexOf("セッション ID をコピー");
  const absoluteAt = html.indexOf("絶対パスをコピー");
  assert.ok(sessionIdAt >= 0 && sessionIdAt < absoluteAt, "⋯ の項目の順が違う");
  assert.ok(!html.includes("disabled"), "取れている項目が disabled になっている");
  assert.ok(html.includes('role="status"'), "コピー成功の読み上げ先 (role=status) が無い");
});

test("描画: 片方だけ取れないときは項目を残して disabled にし、理由を 2 行目に出す", () => {
  const noSession = renderMenu({ root: "projects/foo", absolutePath: "/workspace/projects/foo", projectSession: true });
  assert.ok(noSession.includes("セッション ID をコピー"), "セッション ID の項目が消えている");
  assert.ok(noSession.includes("絶対パスをコピー"), "絶対パスの項目が消えている");
  assert.ok(noSession.includes("disabled"), "取れない項目が disabled になっていない");
  assert.ok(noSession.includes(WORK_FOLDER_SESSION_MISSING), "disabled の理由が出ていない");

  const noAbsolute = renderMenu({ root: `foo/${SESSION_ID}`, sessionId: SESSION_ID, projectSession: false });
  assert.ok(noAbsolute.includes("disabled"), "取れない項目が disabled になっていない");
  assert.ok(noAbsolute.includes(WORK_FOLDER_ABSOLUTE_MISSING), "disabled の理由が出ていない");
});

test("描画: 両方取れないときは ⋯ を出さず、理由をパスの下に常設する", () => {
  const html = renderMenu({ root: "projects/foo", projectSession: true });
  assert.ok(!html.includes("aria-haspopup"), "全項目 disabled なのに ⋯ を出している");
  assert.ok(!html.includes('role="menu"'), "開けないメニューを描いている");
  assert.ok(html.includes(WORK_FOLDER_SESSION_MISSING), "会話が無い理由が出ていない");
  assert.ok(html.includes(WORK_FOLDER_ABSOLUTE_MISSING), "絶対パスが無い理由が出ていない");
  // パス自体は出し続ける (理由だけの面にしない)
  assert.ok(html.includes("/foo"), "パスが出ていない");
});
