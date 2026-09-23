// サイドバーの行の右端の操作。client に DOM テスト基盤が無いため、行の右端の部品だけを
// react-dom/server で描画して見た目と読み上げ名を固定し、2 種類の行が同じ部品を使うことはソース走査で固定する。
//   1. セッションの削除が × に戻る / 設定画面の削除（ゴミ箱）と別の絵になる
//   2. 行の操作ボタンの寸法・読み上げ名・ホバー端末での出し分けがずれる
//   3. プロジェクト行とセッション行がそれぞれボタンを組み立て、右端の位置や大きさがずれる
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { RowAction } from "../src/components/sidebar/RowAction";
import { SessionRow } from "../src/components/sidebar/SessionRow";
import type { SessionSummary } from "../src/types";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

/** TrashIcon の本体 (蓋の横線)。他のアイコンと共有しないため、描画されたゴミ箱の目印に使える */
const TRASH_MARK = "M2.75 4.5h10.5";

function renderRowAction(props: { label: string; danger?: boolean; hoverOnly?: boolean }): string {
  return renderToStaticMarkup(
    createElement(RowAction, { ...props, onClick: () => {}, children: createElement("span", null, "mark") }),
  );
}

function renderSessionRow(): string {
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
  };
  return renderToStaticMarkup(
    createElement(SessionRow, { item, agents: [], active: false, onSelect: () => {}, onDelete: () => {} }),
  );
}

test("行の右端の操作は size-7 で、読み上げ名とホバー端末での出し分けを持つ", () => {
  const html = renderRowAction({ label: "セッションを削除", danger: true, hoverOnly: true });
  assert.ok(html.includes('title="セッションを削除"'), "title が読み上げ名とずれている");
  assert.ok(html.includes('aria-label="セッションを削除"'), "aria-label が無い");
  assert.ok(html.includes("size-7"), "行の操作ボタンが size-7 でない");
  // ホバーできる端末では隠し、行のホバーで出す (タッチ端末では常時表示)
  assert.ok(html.includes("can-hover:opacity-0"), "ホバー端末で隠れない");
  assert.ok(html.includes("can-hover:group-hover:opacity-100"), "行のホバーで出ない");
  assert.ok(html.includes("focus-visible:opacity-100"), "キーボードのフォーカスで出ない");
  // 危険色はボタン自身のホバーだけ (行のホバーでは変えない)
  assert.ok(html.includes("hover:text-danger"), "削除が危険色にならない");
  assert.ok(!html.includes("group-hover:text-danger"), "行のホバーで赤くなる");
  assert.ok(
    renderRowAction({ label: "展開する" }).includes("hover:text-accent-text"),
    "danger 以外がアクセント色でない",
  );
});

test("セッション行の削除は × ではなくゴミ箱で、読み上げ名は「セッションを削除」", () => {
  const html = renderSessionRow();
  assert.ok(html.includes(TRASH_MARK), "削除がゴミ箱 (TrashIcon) でない");
  assert.ok(!html.includes("×"), "× が残っている");
  assert.ok(html.includes('aria-label="セッションを削除"'), "削除の読み上げ名が無い");
  assert.ok(html.includes('title="セッションを削除"'), "削除の title が無い");
  // 設定画面の削除と同じ絵にする (この統一が崩れると画面ごとに削除の印が変わる)
  for (const file of [
    "src/components/agent-settings/AgentEditorForm.tsx",
    "src/components/skill-settings/SkillEditorForm.tsx",
    "src/components/FileBrowser.tsx",
  ]) {
    assert.ok(read(file).includes("<TrashIcon />"), `${file} の削除がゴミ箱でない`);
  }
});

test("プロジェクト行とセッション行は同じ RowAction を使う", () => {
  for (const [label, file] of [
    ["プロジェクト行", "src/components/sidebar/ProjectRow.tsx"],
    ["セッション行", "src/components/sidebar/SessionRow.tsx"],
  ] as const) {
    const source = read(file);
    assert.ok(source.includes('from "./RowAction"'), `${label}が RowAction を import していない`);
    assert.ok(source.includes("<RowAction"), `${label}が RowAction を使っていない`);
    // 行ごとにボタンを組み立てると、寸法とホバーの出し分けがずれる
    assert.ok(
      !source.includes("place-items-center rounded-md text-ink-ghost"),
      `${label}に行独自のボタン定義が残っている`,
    );
  }

  const session = read("src/components/sidebar/SessionRow.tsx");
  const deleteStart = session.indexOf('label="セッションを削除"');
  assert.ok(deleteStart >= 0, "セッション行の削除が RowAction に渡っていない");
  const deleteAction = session.slice(deleteStart, session.indexOf("</RowAction>", deleteStart));
  assert.ok(deleteAction.includes("hoverOnly"), "セッションの削除がホバー端末で隠れない");
  assert.ok(deleteAction.includes("danger"), "セッションの削除が危険色にならない");
  assert.ok(deleteAction.includes("<TrashIcon />"), "セッションの削除がゴミ箱でない");
});
