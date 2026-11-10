// バックアップのダイアログと書き出し対象の描画契約。対象の行が plan から消えても残ること、
// 書き出しの件数が押す前に読めることを固定する。開閉・焦点・Escape はブラウザーで確認する。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { BackupRestoreFlow } from "../src/lib/backupFlow";
import type { BackupExportCheck, BackupRestorePlan } from "../src/types";

globalThis.location ??= { origin: "http://localhost" } as Location;
const { BackupRestoreDialog } = await import("../src/components/backup/BackupRestoreDialog");
const { BackupExportTargets } = await import("../src/components/backup/BackupExportTargets");

const COUNTS = { added: 0, updated: 0, identical: 0, removed: 0, reordered: 0 };

/** 対象を 1 つ OFF にした plan (manifest は 2 対象、plans は選んだ prompts だけ) */
const PARTIAL: BackupRestorePlan = {
  manifest: {
    app: "u7agent",
    schema: 1,
    exportedAt: "2024-05-06T07:08:09.000Z",
    targets: ["prompts", "agents"],
  },
  selected: ["prompts"],
  plans: [
    {
      target: "prompts",
      counts: { ...COUNTS, added: 1 },
      items: [{ id: "p-1", name: "Greeting", status: "added" }],
      truncated: false,
      total: 1,
      warnings: [],
      blocker: null,
    },
  ],
  changed: true,
  blocked: false,
  kept: ["skills"],
};

function renderRestore(flow: Exclude<BackupRestoreFlow, { status: "idle" } | { status: "done" }>): string {
  return renderToStaticMarkup(
    createElement(BackupRestoreDialog, {
      flow,
      onToggleTarget: () => {},
      onConfirmed: () => {},
      onApply: () => {},
      onClose: () => {},
    }),
  );
}

test("OFF にした対象も行として残り、未チェックのトグルで描画される", () => {
  const markup = renderRestore({
    status: "review",
    fileName: "backup.zip",
    selected: ["prompts"],
    plan: PARTIAL,
    confirmed: false,
  });
  // manifest の全対象が出る (plans に無い agents も残る)
  assert.ok(markup.includes("定型プロンプト"));
  assert.ok(markup.includes("エージェント"));
  assert.ok(markup.includes("置き換えない"));
  // 選択中の 1 対象だけがチェックされる (オフの対象は unchecked のまま押せる)
  assert.equal(markup.split('checked=""').length - 1, 1);
  assert.ok(markup.includes("追加 1"));
});

test("plan が全対象を選んでいれば追加の確認は出ず、両方チェックされる", () => {
  const full: BackupRestorePlan = {
    ...PARTIAL,
    selected: ["prompts", "agents"],
    plans: [
      ...PARTIAL.plans,
      {
        target: "agents",
        counts: { ...COUNTS, removed: 1 },
        items: [{ id: "a-1", name: "Extra", status: "removed" }],
        truncated: false,
        total: 1,
        warnings: [],
        blocker: null,
      },
    ],
  };
  const markup = renderRestore({
    status: "review",
    fileName: "backup.zip",
    selected: ["prompts", "agents"],
    plan: full,
    confirmed: false,
  });
  assert.equal(markup.split('checked=""').length - 1, 2);
  assert.ok(markup.includes("削除される定義"));
  assert.ok(markup.includes("既存の定義が削除されることを理解しました"));
});

test("書き出しの対象は件数と書き出せない理由を押す前に出す", () => {
  const check: BackupExportCheck = {
    targets: ["prompts", "agents", "skills"],
    entries: [
      { target: "prompts", count: 1, bytes: 10 },
      { target: "agents", count: 1, bytes: 10 },
      { target: "skills", count: 2, bytes: 20, available: false, reason: "サンドボックスが未設定です" },
    ],
    bytes: 1064,
    fileName: "u7agent-backup-2024-05-06.zip",
  };
  const markup = renderToStaticMarkup(
    createElement(BackupExportTargets, {
      targets: ["prompts", "agents", "skills"],
      all: ["prompts", "agents", "skills"],
      check,
      onToggle: () => {},
    }),
  );
  assert.ok(markup.includes("1 件"));
  // スキルは ZIP のエントリ数ではなくフォルダ数 (2 件) を出す
  assert.ok(markup.includes("2 件"));
  assert.ok(markup.includes("定型プロンプト 1 件 / エージェント 1 件 / 共通スキル 2 件"));
  assert.ok(markup.includes("共通スキルを書き出せません"));
  assert.ok(markup.includes("サンドボックスが未設定です"));
});
