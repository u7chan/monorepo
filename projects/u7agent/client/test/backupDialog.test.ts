// バックアップのダイアログと書き出し対象の描画契約。対象の行が plan から消えても残ること、
// 書き出しの件数が押す前に読めることを固定する。開閉・焦点・Escape はブラウザーで確認する。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { BackupRestoreFlow } from "../src/lib/backupFlow";
import type { BackupExportCheck, BackupResetResult, BackupRestorePlan } from "../src/types";

globalThis.location ??= { origin: "http://localhost" } as Location;
const { BackupRestoreDialog } = await import("../src/components/backup/BackupRestoreDialog");
const { BackupResetDialog } = await import("../src/components/backup/BackupResetDialog");
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
  // 閉じるはヘッダーの X、フッターは実行しない側のキャンセル
  assert.match(markup, /<button[^>]*aria-label="閉じる"[^>]*>/);
  assert.equal(markup.includes(">閉じる<"), false, "フッターに閉じるを残さない");
  assert.ok(markup.includes(">キャンセル<"));
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

/** ヘッダーの閉じる (X)。文字を持たないので読み上げ名で引く */
function closeButtonTag(html: string): string {
  const tag = html.match(/<button[^>]*aria-label="閉じる"[^>]*>/)?.[0];
  assert.ok(tag, "ヘッダーの閉じるが無い");
  return tag;
}

function renderReset(
  flow: { status: "confirm" } | { status: "applying" } | { status: "done"; result: BackupResetResult },
): string {
  return renderToStaticMarkup(
    createElement(BackupResetDialog, {
      flow,
      check: null,
      onApply: () => {},
      onClose: () => {},
    }),
  );
}

test("全削除の確認はヘッダーの X とフッターのキャンセルで閉じ、実行は danger", () => {
  const html = renderReset({ status: "confirm" });
  assert.ok(closeButtonTag(html).includes('title="閉じる"'));
  assert.equal(html.includes(">閉じる<"), false, "フッターに閉じるを残さない");
  assert.ok(html.includes(">キャンセル<"), "実行しない側の名前がキャンセルでない");
  const footer = html.slice(html.indexOf("<footer"));
  assert.ok(footer.indexOf(">キャンセル<") < footer.indexOf(">すべて削除する<"), "主操作が右端に無い");
  assert.match(html, /<button[^>]*class="[^"]*btn-danger[^"]*"[^>]*>すべて削除する</);
});

test("全削除の完了後はフッターを出さず、ヘッダーの X だけにする", () => {
  const html = renderReset({
    status: "done",
    result: { complete: true, agents: 1, prompts: 2, skills: 3, failed: [] },
  });
  assert.equal(html.includes("<footer"), false, "完了後にフッターが残っている");
  assert.equal(closeButtonTag(html).includes('disabled="'), false, "完了後に閉じる導線が無効になっている");
  assert.ok(html.includes("削除しました"));
});
