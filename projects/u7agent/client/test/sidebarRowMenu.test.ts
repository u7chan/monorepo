// サイドバーの行の ⋯ メニュー。client に DOM テスト基盤が無いため、出し分けの純関数を直接固定し、
// 描画は react-dom/server で属性と項目の並びだけを見る (開閉 / 位置 / キーボードは共有部で
// client/test/fileRowMenu.test.ts が固定する)。実ブラウザーでの操作は手動確認に残す。
//   1. プロジェクト行の項目は このプロジェクトに新しい会話 → プロジェクトを削除 (danger) の 2 つ
//   2. セッション行の項目は 名前を変更 → セッションを削除 (danger) の 2 つで、通知のベルは行に残る
//   3. ⋯ は常時表示 (hoverOnly をやめた) で、読み上げ名は <名前> の操作、削除はゴミ箱
//   4. 行の選択 button と ⋯ は兄弟で、RowAction.tsx は残っていない
//   5. 状態ラベルは truncate する部分 (エージェント名 + 時刻) の外の縮まない要素で、選択 button の中の
//      右端 (ベルと ⋯ の左) に出す。待機件数と終端のラベルは行に出さない
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ProjectRow } from "../src/components/sidebar/ProjectRow";
import { SessionRow } from "../src/components/sidebar/SessionRow";
import { projectRowActions, sessionRenamePrompt, sessionRowActions } from "../src/lib/sidebarRowMenu";
import type { Project, SessionSummary } from "../src/types";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

/** TrashIcon の本体 (蓋の横線)。他のアイコンと共有しないため、描画されたゴミ箱の目印に使える */
const TRASH_MARK = "M2.75 4.5h10.5";
/** PlusIcon の本体 (十字)。new-chat が ＋ の絵であることの目印 */
const PLUS_MARK = "M8 3.25v9.5M3.25 8h9.5";
/** PencilIcon の本体 (ペン先)。リネームが鉛筆の絵であることの目印 */
const PENCIL_MARK = "M11.25 2.75l2 2-7.5 7.5-2.6.6.6-2.6z";

const project: Project = { id: "p-1", name: "hello", cwd: "work/hello", createdAt: 0 };

function renderProjectRow(): string {
  return renderToStaticMarkup(
    createElement(ProjectRow, {
      project,
      sessions: [],
      agents: [],
      sessionId: "",
      open: false,
      onToggle: () => {},
      onNewChat: () => {},
      onDelete: () => {},
      onSelectSession: () => {},
      onRenameSession: () => {},
      onDeleteSession: () => {},
    }),
  );
}

function renderSessionRow(overrides: Partial<SessionSummary> = {}): string {
  const item: SessionSummary = {
    sessionId: "s-1",
    title: "テスト",
    agentId: "agent-general",
    agentName: "汎用アシスタント",
    status: "idle",
    queueDepth: 0,
    messageCount: 2,
    createdAt: 0,
    lastUsedAt: 0,
    ...overrides,
  };
  return renderToStaticMarkup(
    createElement(SessionRow, {
      item,
      agents: [],
      active: false,
      onSelect: () => {},
      onRename: () => {},
      onDelete: () => {},
    }),
  );
}

/** ⋯ の button。行の選択 button とは aria-haspopup で区別する */
function menuTrigger(html: string): string {
  const match = /<button[^>]*aria-haspopup="menu"[^>]*>/.exec(html);
  assert.ok(match, "⋯ の button が無い");
  return match[0];
}

/** meta 行 (<small>) の内側。状態ラベルは「truncate する部分」の兄弟としてここに出る */
function metaRow(html: string): string {
  const match = /<small[^>]*>([\s\S]*?)<\/small>/.exec(html);
  assert.ok(match, "meta 行 (small) が無い");
  return match[1];
}

test("出し分け: プロジェクト行は 新しい会話 → 削除、セッション行は 名前を変更 → 削除 を返す", () => {
  assert.deepEqual(projectRowActions(), [
    { kind: "new-chat", label: "このプロジェクトに新しい会話" },
    { kind: "delete", label: "プロジェクトを削除", danger: true },
  ]);
  assert.deepEqual(sessionRowActions(), [
    { kind: "rename", label: "名前を変更" },
    { kind: "delete", label: "セッションを削除", danger: true },
  ]);
  assert.equal(sessionRenamePrompt(), "セッションの新しい名前を入力してください。");
});

test("プロジェクト行の ⋯ は常時表示で、読み上げ名と 2 項目の並びを持つ", () => {
  const html = renderProjectRow();
  const trigger = menuTrigger(html);
  assert.ok(trigger.includes('aria-haspopup="menu"'), "⋯ が aria-haspopup を持たない");
  assert.ok(trigger.includes('aria-expanded="false"'), "⋯ が aria-expanded を持たない");
  assert.ok(trigger.includes('aria-label="hello の操作"'), "⋯ の読み上げ名に行の名前が入っていない");
  assert.ok(trigger.includes("size-6"), "⋯ が RowMenu の size-6 でない");
  // hoverOnly をやめた: ホバー端末でも常時見え、行の hover で見え方が動かない
  assert.ok(!trigger.includes("opacity-0"), "⋯ がホバー端末で隠れる");
  assert.ok(!trigger.includes("can-hover:"), "⋯ にホバー端末の出し分けが残っている");

  // 項目は このプロジェクトに新しい会話 → プロジェクトを削除 の順で、danger は削除だけ
  const items = html.split("<button").filter((part) => part.includes('role="menuitem"'));
  assert.equal(items.length, 2, "項目数が違う");
  const newChat = html.indexOf("このプロジェクトに新しい会話");
  const remove = html.indexOf("プロジェクトを削除");
  assert.ok(newChat >= 0 && newChat < remove, "並びが 新しい会話 → 削除 でない");
  assert.ok(items[0].includes(PLUS_MARK), "「このプロジェクトに新しい会話」が ＋ の絵でない");
  assert.ok(items[1].includes(TRASH_MARK), "「プロジェクトを削除」がゴミ箱でない");
  assert.ok(items[1].includes("text-danger-text"), "削除が danger でない");
  assert.ok(!items[0].includes("text-danger-text"), "削除以外に danger が付いている");
  // chevron は消した (折りたたみは行のクリック 1 つ。行の button が aria-expanded を持つ)
  assert.ok(!html.includes('aria-label="展開する"'), "折りたたみの chevron が残っている");
  assert.ok(html.includes('aria-expanded="false"'), "行の button が aria-expanded を持たない");
});

test("セッション行の ⋯ は 名前を変更 → 削除 の 2 項目で、通知のベルは行に残る", () => {
  const html = renderSessionRow();
  const trigger = menuTrigger(html);
  assert.ok(trigger.includes('aria-label="テスト の操作"'), "⋯ の読み上げ名にセッション名が入っていない");
  assert.ok(trigger.includes("size-6"), "⋯ が RowMenu の size-6 でない");
  assert.ok(!trigger.includes("opacity-0"), "⋯ がホバー端末で隠れる");

  const items = html.split("<button").filter((part) => part.includes('role="menuitem"'));
  assert.equal(items.length, 2, "項目数が違う");
  const rename = html.indexOf("名前を変更");
  const remove = html.indexOf("セッションを削除");
  assert.ok(rename >= 0 && rename < remove, "並びが 名前を変更 → 削除 でない");
  assert.ok(items[0].includes(PENCIL_MARK), "名前を変更が鉛筆 (PencilIcon) でない");
  assert.ok(!items[0].includes("text-danger-text"), "名前を変更に danger が付いている");
  assert.ok(items[1].includes(TRASH_MARK), "削除がゴミ箱 (TrashIcon) でない");
  assert.ok(items[1].includes("text-danger-text"), "削除が danger でない");
  assert.ok(!html.includes("×"), "× が残っている");

  // 通知のベルは状態の印なので行に残す (メニューへ移さない)。タイトルの無い行も読み上げ名が空にならない
  const withBell = renderSessionRow({ notify: true });
  assert.ok(withBell.includes('aria-label="通知オン"'), "通知のベルが行に残っていない");
  assert.ok(menuTrigger(withBell).includes('aria-label="テスト の操作"'));
  assert.ok(menuTrigger(renderSessionRow({ title: "" })).includes('aria-label="無題のセッション の操作"'));
});

test("圧縮中のセッションは行に「圧縮中」を出し、実行中と同じ動きのある点で示す", () => {
  const html = renderSessionRow({ status: "compacting" });

  assert.ok(html.includes("圧縮中"), "状態ラベルが無い");
  assert.ok(!html.includes("実行中"), "実行中のラベルを出している");
  assert.ok(html.includes("dot-pulse"), "実行中と同じ動きのある点で示す");
  // 色と点は実行中と同じなので、区別はラベルが担う
  assert.ok(html.includes("dot-accent"), "アクセント色の点でない");
});

test("状態ラベルは truncate の兄弟で、選択 button の中の右端 (ベルと ⋯ の左) に並ぶ", () => {
  for (const status of ["running", "queued"] as const) {
    // 実行中と同じ行を、待機件数 3 件と通知 On で描く (待機件数は行に出さない)
    const html = renderSessionRow({ status, queueDepth: 3, notify: true });
    const meta = metaRow(html);

    // truncate する部分 (エージェント名 + 時刻) は伸びる側で、状態ラベルを含まない
    const truncate = /<span class="([^"]*)">([^<]+)<\/span>/.exec(meta);
    assert.ok(truncate, `${status}: truncate する部分が無い`);
    assert.ok(truncate[1].includes("flex-1"), `${status}: truncate 側が伸びない`);
    assert.ok(truncate[1].includes("truncate"), `${status}: truncate 側が切れない`);
    assert.match(truncate[2], /汎用アシスタント · /, `${status}: エージェント名と時刻が出ていない`);

    // ラベルは truncate 側の兄弟で、縮まない要素 (右端 = meta 行の末尾) に置く
    const label = /<span class="([^"]*)" title="([^"]*)">([^<]*)<\/span>/.exec(meta);
    assert.ok(label, `${status}: 状態ラベルが無い`);
    assert.equal(label[2], "実行中", `${status}: ラベルに title が無い`);
    assert.equal(label[3], "実行中", `${status}: ラベルが実行中でない`);
    assert.ok(label[1].includes("shrink-0"), `${status}: ラベルが縮む側にある`);
    assert.ok(!label[1].includes("truncate"), `${status}: ラベルが truncate される`);
    assert.ok(meta.indexOf(truncate[0]) < meta.indexOf(label[0]), `${status}: ラベルが truncate の手前にある`);
    assert.ok(meta.endsWith(label[0]), `${status}: ラベルが右端に無い`);

    // ラベルは選択 button の中にあり、ベルと ⋯ より手前 (左) にある
    assert.ok(html.indexOf(label[0]) < html.indexOf("</button>"), `${status}: ラベルが選択 button の外にある`);
    assert.ok(html.indexOf(label[0]) < html.indexOf('aria-label="通知オン"'), `${status}: ラベルがベルの右にある`);
    assert.ok(html.indexOf(label[0]) < html.indexOf('aria-haspopup="menu"'), `${status}: ラベルが ⋯ の右にある`);

    // queued は独立したラベルにせず、待機件数も行に出さない (待機は Composer が示す)
    assert.ok(!html.includes("キュー待ち"), `${status}: queued を独立したラベルにしている`);
    assert.ok(!html.includes("待機"), `${status}: 待機件数が行に残っている`);
    // live の点は実行中 / 圧縮中で共通
    assert.ok(
      html.includes('<span class="dot dot-accent dot-pulse" aria-hidden="true">'),
      `${status}: live の点でない`,
    );
  }
});

test("終端と idle の行は状態ラベルも title も出さず、idle の点にする", () => {
  for (const status of ["completed", "stopped", "error", "idle"] as const) {
    const html = renderSessionRow({ status });
    const meta = metaRow(html);
    assert.ok(!meta.includes("実行中"), `${status}: 実行中が出ている`);
    assert.ok(!meta.includes("圧縮中"), `${status}: 圧縮中が出ている`);
    assert.ok(
      !html.includes('title="実行中"') && !html.includes('title="圧縮中"'),
      `${status}: 状態の title が残っている`,
    );
    assert.ok(html.includes('<span class="dot dot-idle" aria-hidden="true">'), `${status}: idle の点でない`);
    assert.ok(html.includes("汎用アシスタント"), `${status}: エージェント名まで消えている`);
  }
});

test("削除の印はゴミ箱で、設定 → エージェント / スキル と共有する", () => {
  for (const file of [
    "src/components/agent-settings/AgentEditorForm.tsx",
    "src/components/skill-settings/SkillEditorForm.tsx",
    "src/components/RowMenu.tsx",
  ]) {
    assert.ok(read(file).includes("<TrashIcon />"), `${file} の削除がゴミ箱でない`);
  }
});

test("行は共有の RowMenu を使い、選択 button と ⋯ は兄弟になる", () => {
  for (const [label, file, actions] of [
    ["プロジェクト行", "src/components/sidebar/ProjectRow.tsx", "projectRowActions()"],
    ["セッション行", "src/components/sidebar/SessionRow.tsx", "sessionRowActions()"],
  ] as const) {
    const source = read(file);
    assert.ok(source.includes('from "../RowMenu"'), `${label}が RowMenu を import していない`);
    assert.ok(source.includes("<RowMenu"), `${label}が RowMenu を使っていない`);
    assert.ok(source.includes(actions), `${label}が純関数の出し分けを使っていない`);
    assert.ok(
      !source.includes('from "./RowAction"') && !source.includes("<RowAction"),
      `${label}に RowAction が残っている`,
    );
    // 入れ子の interactive control を作らない: 行の選択 button の中に ⋯ を置かない
    const selectButton = source.slice(source.indexOf("<button"), source.indexOf("</button>"));
    assert.ok(!selectButton.includes("<RowMenu"), `${label}の ⋯ が行の選択 button の入れ子になっている`);
    // 行ごとにボタンを組み立てると寸法と見え方がずれる
    assert.ok(
      !source.includes("place-items-center rounded-md text-ink-ghost"),
      `${label}に行独自のボタン定義が残っている`,
    );
  }

  // 利用者が消えた RowAction.tsx は残さない (寸法とホバーの出し分けは RowMenu 1 箇所へ)
  assert.ok(
    !existsSync(fileURLToPath(new URL("../src/components/sidebar/RowAction.tsx", import.meta.url))),
    "RowAction.tsx が残っている",
  );
});

test("アイコン: RowMenu は new-chat に ＋ を当てる (アイコン表は 1 箇所のまま)", () => {
  const source = read("src/components/RowMenu.tsx");
  assert.match(source, /"new-chat": <PlusIcon \/>/, "new-chat のアイコンが ＋ でない");
  assert.equal((source.match(/<PlusIcon \/>/g) ?? []).length, 1, "＋ のアイコンを 2 箇所に書いている");
});
