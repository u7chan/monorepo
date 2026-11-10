// 設定 → バックアップの文言 / 確認要否 (純関数) と、書き出し / plan / 適用 / 全削除の状態遷移。
// 通信と DOM は注入した fake で固定し、HTTP の契約は apiContracts.test.ts が見る。
import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKUP_KEPT_NOTE,
  backupBlockerText,
  backupCanApply,
  backupCountsSummary,
  backupNeedsDeleteConfirm,
  backupRemovedNames,
  backupTotalSummary,
  backupWarningTexts,
} from "../src/lib/backup";
import { createBackup, createBackupStore, isBackupFileName } from "../src/lib/backupFlow";
import type { BackupRestorePlan, BackupRestoreResult, BackupTarget } from "../src/types";

const COUNTS = { added: 0, updated: 0, identical: 0, removed: 0, reordered: 0 };

function planOf(overrides: Partial<BackupRestorePlan> = {}): BackupRestorePlan {
  return {
    manifest: {
      app: "u7agent",
      schema: 1,
      exportedAt: "2024-05-06T07:08:09.000Z",
      targets: ["prompts", "agents"],
    },
    selected: ["prompts", "agents"],
    plans: [
      {
        target: "prompts",
        counts: COUNTS,
        items: [],
        truncated: false,
        total: 0,
        warnings: [],
        blocker: null,
      },
    ],
    changed: true,
    blocked: false,
    kept: ["skills"],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface Calls {
  /** 初回 plan は targets を送らない (undefined) */
  plan: [string, readonly BackupTarget[] | undefined][];
  apply: [string, string[]][];
  download: [string, string][];
  notes: string[];
}

function makeBackup(
  options: {
    plan?: (targets: readonly BackupTarget[] | undefined) => Promise<BackupRestorePlan>;
    apply?: (targets: readonly BackupTarget[]) => Promise<BackupRestoreResult>;
  } = {},
) {
  const calls: Calls = { plan: [], apply: [], download: [], notes: [] };
  let reloads = 0;
  const backup = createBackup({
    checkExport: async (targets) => ({
      targets: [...targets],
      entries: targets.map((target) => ({ target, count: 1, bytes: 10 })),
      bytes: 30,
      fileName: "u7agent-backup-2024-05-06.zip",
    }),
    exportUrl: (targets) => `http://localhost/api/backup/export?targets=${targets.join(",")}`,
    startDownload: (url, name) => calls.download.push([url, name]),
    planRestore: async (file, targets) => {
      calls.plan.push([file.name, targets === undefined ? undefined : [...targets]]);
      // サーバーは targets 省略時に manifest の全対象を選ぶ
      return options.plan
        ? options.plan(targets)
        : planOf({ selected: targets === undefined ? ["prompts", "agents"] : [...targets] });
    },
    applyRestore: async (file, targets) => {
      calls.apply.push([file.name, [...targets]]);
      return options.apply ? options.apply(targets) : { complete: true, plan: planOf(), applied: [], failed: [] };
    },
    resetDefinitions: async () => ({ complete: true, agents: 2, prompts: 1, skills: 1, failed: [] }),
    blockedPlan: (error) => (error as { plan?: BackupRestorePlan } | null)?.plan ?? null,
    reload: () => {
      reloads += 1;
    },
    note: (text) => calls.notes.push(text),
  });
  return { backup, calls, reloads: () => reloads };
}

const zip = (name = "u7agent-backup.zip") => new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], name);

const withRemoval = (selected: readonly BackupTarget[] = ["prompts", "agents"]) =>
  planOf({
    selected: [...selected],
    plans: [
      {
        target: "prompts",
        counts: { ...COUNTS, removed: 1, added: 1 },
        items: [
          { id: "p-1", name: "Greeting", status: "removed" },
          { id: "p-2", name: "Fresh", status: "added" },
        ],
        truncated: false,
        total: 1,
        warnings: [{ code: "model_unknown", name: "p/m" }],
        blocker: null,
      },
    ],
  });

test("差分の件数と削除の確認要否は plan の counts だけで決まる", () => {
  assert.equal(
    backupCountsSummary({ added: 1, updated: 2, identical: 3, removed: 0, reordered: 4 }),
    "追加 1 / 更新 2 / 同一 3 / 並び替え 4",
  );
  assert.equal(backupCountsSummary(COUNTS), "変更なし");
  assert.equal(backupNeedsDeleteConfirm(planOf()), false);
  assert.equal(backupNeedsDeleteConfirm(withRemoval()), true);
  // 削除が無ければ確認なしで適用でき、削除があればチェックが要る
  assert.equal(backupCanApply(planOf(), false), true);
  assert.equal(backupCanApply(withRemoval(), false), false);
  assert.equal(backupCanApply(withRemoval(), true), true);
  // ブロッカーがある / 変更が無い plan は確認済みでも適用しない
  assert.equal(backupCanApply(planOf({ blocked: true }), true), false);
  assert.equal(backupCanApply(planOf({ changed: false }), false), false);
});

test("削除される名前は上限で打ち切り、復元後の件数と警告を文言にする", () => {
  const plan = withRemoval();
  assert.deepEqual(backupRemovedNames(plan), ["Greeting"]);
  assert.equal(backupTotalSummary(plan), "復元後: 定型プロンプト 1 件");
  assert.deepEqual(backupWarningTexts(plan.plans[0].warnings), [
    "モデル一覧を取得できないため、モデルを保持しました: p/m",
  ]);
  assert.equal(
    backupBlockerText({ code: "prompt_in_use", message: "raw", names: ["Greeting"] }),
    "適用後も残るエージェントが参照している定型プロンプトは削除できません: Greeting",
  );
  assert.ok(BACKUP_KEPT_NOTE.includes("プロジェクト"));
  assert.equal(isBackupFileName("backup.zip"), true);
  assert.equal(isBackupFileName("backup.ZIP"), true);
  assert.equal(isBackupFileName("backup.tar"), false);
});

test("書き出しは check の保存名で URL を開き、進行中は二重に送らない", async () => {
  const { backup, calls } = makeBackup({});
  await backup.exportBackup(["prompts", "agents"]);
  assert.deepEqual(calls.download, [
    ["http://localhost/api/backup/export?targets=prompts,agents", "u7agent-backup-2024-05-06.zip"],
  ]);
  // 0 件のときは保存を始めず、理由を注記にする
  const empty = createBackup({
    checkExport: async (targets) => ({ targets: [...targets], entries: [], bytes: 0, fileName: "x.zip" }),
    exportUrl: () => "http://localhost/api/backup/export",
    startDownload: () => calls.download.push(["unexpected", "unexpected"]),
    planRestore: async () => planOf(),
    applyRestore: async () => ({ complete: true, plan: planOf(), applied: [], failed: [] }),
    resetDefinitions: async () => ({ complete: true, agents: 0, prompts: 0, skills: 0, failed: [] }),
    blockedPlan: () => null,
    reload: () => {},
    note: (text) => calls.notes.push(text),
  });
  await empty.exportBackup(["prompts"]);
  assert.equal(calls.download.length, 1);
  assert.equal(calls.notes.at(-1), "書き出せる定義がありません。");
});

test("ファイル選択で全体 plan を取り、削除があるときはチェックなしに適用しない", async () => {
  const { backup, calls, reloads } = makeBackup({ plan: async () => withRemoval() });
  await backup.selectRestoreFile(zip());
  const flow = backup.state().restore;
  assert.equal(flow.status, "review");
  if (flow.status !== "review") return;
  // 初回は targets を送らない (一部の対象だけの ZIP でも 400 にしない)
  assert.deepEqual(calls.plan, [["u7agent-backup.zip", undefined]]);
  assert.deepEqual(flow.plan.manifest.targets, ["prompts", "agents"]);
  assert.equal(flow.confirmed, false);

  await backup.apply();
  assert.deepEqual(calls.apply, []);
  backup.setConfirmed(true);
  await backup.apply();
  assert.deepEqual(calls.apply, [["u7agent-backup.zip", ["prompts", "agents"]]]);
  assert.equal(backup.state().restore.status, "done");
  assert.equal(reloads(), 1);
});

test("対象トグルは plan を取り直し、確認チェックを戻す", async () => {
  const { backup, calls } = makeBackup({ plan: async (targets) => withRemoval(targets) });
  await backup.selectRestoreFile(zip());
  backup.setConfirmed(true);
  await backup.toggleTarget("agents");
  const flow = backup.state().restore;
  assert.equal(flow.status, "review");
  if (flow.status !== "review") return;
  assert.deepEqual(calls.plan.at(-1), ["u7agent-backup.zip", ["prompts"]]);
  assert.equal(flow.confirmed, false);
  // バックアップに含まれない対象は切り替えられない / 最後の 1 つは外せない
  await backup.toggleTarget("skills");
  await backup.toggleTarget("prompts");
  assert.equal(calls.plan.length, 2);
});

test("古い plan の応答は新しい plan を上書きせず、planning 中は適用できない", async () => {
  const first = deferred<BackupRestorePlan>();
  const second = deferred<BackupRestorePlan>();
  let index = 0;
  const { backup, calls } = makeBackup({
    plan: () => {
      index += 1;
      return index === 1 ? first.promise : second.promise;
    },
  });
  // 1 回目の plan が返る前に閉じて選び直す (古い応答は捨てる)
  const stale = backup.selectRestoreFile(zip("old.zip"));
  assert.equal(backup.state().restore.status, "planning");
  await backup.apply();
  assert.deepEqual(calls.apply, []);
  backup.closeRestore();
  assert.equal(backup.state().restore.status, "idle");
  const fresh = backup.selectRestoreFile(zip("new.zip"));
  second.resolve(planOf({ selected: ["agents"] }));
  await fresh;
  const flow = backup.state().restore;
  assert.equal(flow.status, "review");
  if (flow.status !== "review") return;
  assert.deepEqual(flow.selected, ["agents"]);
  // 遅れて届いた古い応答は捨てる
  first.resolve(planOf({ selected: ["prompts", "agents"] }));
  await stale;
  const after = backup.state().restore;
  assert.equal(after.status, "review");
  if (after.status !== "review") return;
  assert.equal(after.fileName, "new.zip");
  assert.deepEqual(after.selected, ["agents"]);
});

test("適用の失敗は確認へ戻して理由を出し、再試行できる", async () => {
  const { backup, calls } = makeBackup({
    apply: async () => {
      throw new Error("Another backup operation is running");
    },
  });
  await backup.selectRestoreFile(zip());
  backup.setConfirmed(true);
  await backup.apply();
  const flow = backup.state().restore;
  assert.equal(flow.status, "review");
  if (flow.status !== "review") return;
  assert.equal(flow.confirmed, false);
  assert.equal(calls.notes.at(-1), "Another backup operation is running");
  // もう一度送れる (サーバーは受信した ZIP で再判定する)
  await backup.apply();
  assert.equal(calls.apply.length, 2);
});

test("削除件数は打ち切られた行ではなく counts から数える", () => {
  // items は 5 件までしか載らないが、実際の削除は 60 件
  const plan = planOf({
    selected: ["prompts"],
    plans: [
      {
        target: "prompts",
        counts: { ...COUNTS, removed: 60 },
        items: ["a", "b", "c", "d", "e"].map((id) => ({ id, name: `name-${id}`, status: "removed" as const })),
        truncated: true,
        total: 0,
        warnings: [],
        blocker: null,
      },
    ],
  });
  assert.deepEqual(backupRemovedNames(plan), ["name-a", "name-b", "name-c", "name-d", "name-e", "ほか 55 件"]);
});

test("適用の 409 blocked が添える再 plan を取り込み、古い plan を表示し続けない", async () => {
  const fresh = withRemoval(["prompts"]);
  fresh.blocked = true;
  fresh.changed = false;
  fresh.plans[0].blocker = { code: "prompt_in_use", message: "raw", names: ["Greeting"] };
  const { backup, calls } = makeBackup({
    apply: async () => {
      throw Object.assign(new Error("The backup cannot be restored as selected"), {
        code: "blocked",
        plan: fresh,
      });
    },
  });
  await backup.selectRestoreFile(zip());
  backup.setConfirmed(true);
  await backup.apply();
  const flow = backup.state().restore;
  assert.equal(flow.status, "review");
  if (flow.status !== "review") return;
  // 409 の plan が表示に反映され、確認はやり直しになる
  assert.deepEqual(flow.plan, fresh);
  assert.equal(flow.confirmed, false);
  assert.equal(calls.notes.at(-1), "The backup cannot be restored as selected");
});

test("再描画で reload が差し替わってもストアは作り直さず、開いたダイアログを保つ", async () => {
  let reloads = 0;
  const store = createBackupStore((reload) =>
    createBackup({
      checkExport: async (targets) => ({ targets: [...targets], entries: [], bytes: 0, fileName: "x.zip" }),
      exportUrl: () => "http://localhost/api/backup/export",
      startDownload: () => {},
      planRestore: async () => planOf(),
      applyRestore: async () => ({ complete: true, plan: planOf(), applied: [], failed: [] }),
      resetDefinitions: async () => ({ complete: true, agents: 0, prompts: 0, skills: 0, failed: [] }),
      blockedPlan: () => null,
      reload,
      note: () => {},
    }),
  );
  await store.backup.selectRestoreFile(zip());
  assert.equal(store.backup.state().restore.status, "review");
  const mounted = store.backup;
  // App の再描画に相当する (deps の差し替え)
  store.update({ reload: () => (reloads += 1) });
  assert.equal(store.backup, mounted);
  assert.equal(store.backup.state().restore.status, "review");
  // 作り直すと idle に戻る (これが再描画でダイアログが閉じる原因だった)
  const recreated = createBackupStore((reload) =>
    createBackup({
      checkExport: async (targets) => ({ targets: [...targets], entries: [], bytes: 0, fileName: "x.zip" }),
      exportUrl: () => "http://localhost/api/backup/export",
      startDownload: () => {},
      planRestore: async () => planOf(),
      applyRestore: async () => ({ complete: true, plan: planOf(), applied: [], failed: [] }),
      resetDefinitions: async () => ({ complete: true, agents: 0, prompts: 0, skills: 0, failed: [] }),
      blockedPlan: () => null,
      reload,
      note: () => {},
    }),
  );
  assert.equal(recreated.backup.state().restore.status, "idle");
});

test("全削除は確認を開いてから 1 回だけ実行する", async () => {
  const { backup, calls, reloads } = makeBackup({});
  backup.openReset();
  assert.equal(backup.state().reset.status, "confirm");
  // 確認していない状態では実行しない (画面のボタンはチェック必須)
  await backup.applyReset();
  assert.equal(backup.state().reset.status, "done");
  assert.equal(calls.notes.at(-1), "削除しました (エージェント 2 件 / 定型プロンプト 1 件 / 共通スキル 1 件)");
  assert.equal(reloads(), 1);
  // 進行中の再実行は何もしない
  const applying = backup.applyReset();
  await applying;
  assert.equal(backup.state().reset.status, "done");
});
