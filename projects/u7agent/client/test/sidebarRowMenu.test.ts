import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ProjectRow } from "../src/components/sidebar/ProjectRow";
import { SessionRow } from "../src/components/sidebar/SessionRow";
import { rowMenuDescriptionKind } from "../src/lib/rowMenu";
import {
  projectRowActions,
  sessionDeleteConfirmRequest,
  sessionRenameRequest,
  sessionRowActions,
} from "../src/lib/sidebarRowMenu";
import type { Project, SessionSummary } from "../src/types";

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
      onTogglePinnedSession: () => {},
      onHandoffSession: () => {},
    }),
  );
}

function renderSessionRow(
  overrides: Partial<SessionSummary> = {},
  onHandoff?: () => void,
  onOpenTitleSummary?: () => void,
): string {
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
    pinned: false,
    serveCommand: null,
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
      onTogglePin: () => {},
      ...(onHandoff ? { onHandoff } : {}),
      ...(onOpenTitleSummary ? { onOpenTitleSummary } : {}),
    }),
  );
}

/** ⋯ の button。行の選択 button とは aria-haspopup で区別する */
function menuTrigger(html: string): string {
  const match = /<button[^>]*aria-haspopup="menu"[^>]*>/.exec(html);
  assert.ok(match, "⋯ の button が無い");
  return match[0];
}

test("出し分け: プロジェクト行とセッション行で必要な操作を返す", () => {
  assert.deepEqual(projectRowActions(), [
    { kind: "new-chat", label: "このプロジェクトに新しい会話" },
    { kind: "delete", label: "プロジェクトを削除", danger: true },
  ]);
  // 診断 (ダンプ / 生ログ) は行に出さない。入口は 設定 → ランタイム の診断タブだけ
  assert.deepEqual(sessionRowActions(), [
    { kind: "pin", label: "ピン留め" },
    { kind: "rename", label: "名前を変更" },
    { kind: "delete", label: "セッションを削除", danger: true },
  ]);
  assert.equal(sessionRowActions({ pinned: true })[0]?.label, "ピン留めを解除");
  // 実行中・圧縮中・片付け中は無効にし、理由を説明行へ出す (項目ごと隠さない)
  assert.deepEqual(sessionRowActions({ canHandoff: true, handoffBlockedReason: "実行中です" }), [
    { kind: "pin", label: "ピン留め" },
    { kind: "rename", label: "名前を変更" },
    {
      kind: "handoff",
      label: "会話を引き継ぐ",
      description: "実行中です",
      descriptionKind: "disclosure",
      disabled: true,
    },
    { kind: "delete", label: "セッションを削除", danger: true },
  ]);
});

test("説明の区分: 分類の無い説明は開示として扱う", () => {
  // 今のセッション行に補足は無いが、追加時に singleColumn で勝手に消えないようにする
  assert.equal(rowMenuDescriptionKind({}), "disclosure");
  assert.equal(rowMenuDescriptionKind({ descriptionKind: "note" }), "note");
});

test("セッションの削除確認は対象のタイトルを出し、リネームは現在のタイトルを初期値にする", () => {
  const remove = sessionDeleteConfirmRequest("決済画面の検証");
  assert.equal(remove.title, "セッションを削除");
  assert.deepEqual(remove.subject, { label: "削除するセッション", value: "決済画面の検証" });
  assert.equal(remove.confirmLabel, "削除する");
  assert.ok(remove.danger, "削除は danger にする");
  // 一覧が古くてタイトルが取れない行でも確認は出す (対象の行を省くだけ)
  assert.equal(sessionDeleteConfirmRequest("").subject, undefined);

  const rename = sessionRenameRequest("決済画面の検証");
  assert.equal(rename.kind, "prompt");
  assert.equal(rename.defaultValue, "決済画面の検証");
  assert.equal(rename.confirmLabel, "名前を変更");
});

test("プロジェクト行の操作は読み上げ名と 2 項目の並びを持つ", () => {
  const html = renderProjectRow();
  const trigger = menuTrigger(html);
  assert.ok(trigger.includes('aria-haspopup="menu"'), "⋯ が aria-haspopup を持たない");
  assert.ok(trigger.includes('aria-expanded="false"'), "⋯ が aria-expanded を持たない");
  assert.ok(trigger.includes('aria-label="hello の操作"'), "⋯ の読み上げ名に行の名前が入っていない");

  const items = html.split("<button").filter((part) => part.includes('role="menuitem"'));
  assert.equal(items.length, 2, "項目数が違う");
  const newChat = html.indexOf("このプロジェクトに新しい会話");
  const remove = html.indexOf("プロジェクトを削除");
  assert.ok(newChat >= 0 && newChat < remove, "並びが 新しい会話 → 削除 でない");

  // chevron は消した (折りたたみは行のクリック 1 つ。行の button が aria-expanded を持つ)
  assert.ok(!html.includes('aria-label="展開する"'), "折りたたみの chevron が残っている");
  assert.ok(html.includes('aria-expanded="false"'), "行の button が aria-expanded を持たない");
});

test("セッション行はピン状態を示し、⋯ に切替・改名・削除を出して通知のベルも残す", () => {
  const html = renderSessionRow();
  const trigger = menuTrigger(html);
  assert.ok(trigger.includes('aria-label="テスト の操作"'), "⋯ の読み上げ名にセッション名が入っていない");

  const items = html.split("<button").filter((part) => part.includes('role="menuitem"'));
  assert.equal(items.length, 3, "項目数が違う");
  const pin = html.indexOf("ピン留め");
  const rename = html.indexOf("名前を変更");
  const remove = html.indexOf("セッションを削除");
  assert.ok(pin >= 0 && pin < rename && rename < remove, "並びが ピン留め → 名前を変更 → 削除 でない");

  const pinned = renderSessionRow({ pinned: true });
  assert.ok(pinned.includes('aria-label="ピン留め中"'), "ピン留めの状態印が無い");
  assert.ok(pinned.includes("ピン留めを解除"), "ピン留め解除の操作が出ない");
  assert.ok(!html.includes('aria-label="ピン留め中"'), "未固定なのに状態印が出ている");

  assert.ok(!html.includes("×"), "× が残っている");

  // 通知のベルは状態の印なので行に残す (メニューへ移さない)。タイトルの無い行も読み上げ名が空にならない
  const withBell = renderSessionRow({ notify: true });
  assert.ok(withBell.includes('aria-label="通知オン"'), "通知のベルが行に残っていない");
  assert.ok(menuTrigger(withBell).includes('aria-label="テスト の操作"'));
  assert.ok(menuTrigger(renderSessionRow({ title: "" })).includes('aria-label="無題のセッション の操作"'));
});

test("引き継ぎの項目は操作の受け取りと揃った行だけに出て、無効な行は理由を出す", () => {
  // 操作を渡さない一覧では出さない (受け取りの無い項目を押させない)
  assert.ok(!renderSessionRow({}).includes("会話を引き継ぐ"));
  assert.ok(renderSessionRow({}, () => {}).includes("会話を引き継ぐ"));
  // 実行中は項目を残したまま無効にし、押せない理由を説明行へ出す
  const running = renderSessionRow({ status: "running" }, () => {});
  const item = running.split("<button").find((part) => part.includes("会話を引き継ぐ"));
  assert.ok(item, "実行中でも項目が出ていない");
  assert.match(item, /disabled/, "実行中なのに押せてしまう");
  assert.ok(running.includes("実行中・キュー待ち・圧縮中は引き継げません"), "無効の理由が無い");
});

test("圧縮中のセッションは実行中と区別できるラベルを出す", () => {
  const html = renderSessionRow({ status: "compacting" });

  assert.ok(html.includes("圧縮中"), "状態ラベルが無い");
  assert.ok(!html.includes("実行中"), "実行中のラベルを出している");
});

test("実行中とキュー待ちは実行中のラベルを表示し、待機件数は行に出さない", () => {
  for (const status of ["running", "queued"] as const) {
    const html = renderSessionRow({ status, queueDepth: 3, notify: true });
    assert.match(html, /title="実行中"[^>]*>実行中<\/span>/);
    assert.ok(html.includes("汎用アシスタント"));
    assert.ok(html.includes('aria-label="通知オン"'));
    assert.ok(!html.includes("キュー待ち"), `${status}: queued を独立したラベルにしている`);
    assert.ok(!html.includes("待機"), `${status}: 待機件数が行に残っている`);
  }
});

test("終端と idle の行は実行状態のラベルも title も出さない", () => {
  for (const status of ["completed", "stopped", "error", "idle"] as const) {
    const html = renderSessionRow({ status });
    assert.ok(!html.includes("実行中"), `${status}: 実行中が出ている`);
    assert.ok(!html.includes("圧縮中"), `${status}: 圧縮中が出ている`);
    assert.ok(
      !html.includes('title="実行中"') && !html.includes('title="圧縮中"'),
      `${status}: 状態の title が残っている`,
    );

    assert.ok(html.includes("汎用アシスタント"), `${status}: エージェント名まで消えている`);
  }
});

test("AI要約の項目は状態の文字を添え、操作を渡した行だけに出る", () => {
  // 状態を渡さない呼び出し (既存の一覧) は項目ごと出さない
  assert.ok(!sessionRowActions().some((action) => action.kind === "title-summary"));

  const done = { origin: "ai" as const, attempt: { runId: "r-1", at: 1, state: "done" as const } };
  const withTitle = sessionRowActions({ canTitleSummary: true, titleSummary: done });
  assert.deepEqual(withTitle[2], {
    kind: "title-summary",
    label: "AI要約",
    status: { text: "済み", tone: "accent" },
    descriptionKind: "note",
  });

  const html = renderSessionRow({ titleSummary: done }, undefined, () => {});
  assert.ok(html.includes("AI要約"), "AI要約の項目が無い");
  assert.ok(html.includes("済み"), "状態の文字が無い");
  assert.match(html, /AI要約[\s\S]*済み/);

  const disabled = renderSessionRow(
    {
      titleSummary: {
        origin: "auto",
        attempt: { runId: "r-2", at: 1, state: "skipped", skipReason: "disabled" },
      },
    },
    undefined,
    () => {},
  );
  assert.ok(disabled.includes("無効"), "Off の状態が無効にならない");
  assert.ok(!renderSessionRow({ titleSummary: done }).includes("AI要約"), "操作を渡していないのに項目が出る");
});
