/**
 * 設定 → バックアップ (`/settings/backup`) の状態機械。書き出し / plan / 適用 / 全削除をここへ閉じ、
 * 通信と DOM (保存の開始) は注入された deps だけを触る。画面は購読した状態を描画するだけにする。
 * plan と apply は同じ `File` を送る (サーバーは状態を持たず、apply が受信した ZIP で再判定する)。
 */
import {
  BACKUP_EXPORT_BLOCKED_NOTE,
  BACKUP_EXPORT_EMPTY_NOTE,
  BACKUP_EXPORT_STARTED_NOTE,
  BACKUP_RESTORE_NOT_ZIP_NOTE,
  BACKUP_TARGET_LABELS,
  backupCanApply,
  backupResetDoneNote,
  backupRestoreDoneNote,
} from "./backup";
import type {
  BackupExportCheck,
  BackupResetResult,
  BackupRestorePlan,
  BackupRestoreResult,
  BackupTarget,
} from "../types";

/** 復元の段階。plan は何も変更せず、適用するのは review で確認した後だけ */
export type BackupRestoreFlow =
  | { status: "idle" }
  | { status: "planning"; fileName: string; selected: BackupTarget[] }
  | {
      status: "review";
      fileName: string;
      selected: BackupTarget[];
      plan: BackupRestorePlan;
      confirmed: boolean;
    }
  | {
      status: "applying";
      fileName: string;
      selected: BackupTarget[];
      plan: BackupRestorePlan;
      confirmed: boolean;
    }
  | { status: "done"; result: BackupRestoreResult };

/** 全削除の段階。確認ダイアログを開いてから実行する */
export type BackupResetFlow =
  | { status: "idle" }
  | { status: "confirm" }
  | { status: "applying" }
  | { status: "done"; result: BackupResetResult };

export type BackupState = {
  /** 書き出しの check を送っている間だけ true (二重に送らない) */
  exporting: boolean;
  restore: BackupRestoreFlow;
  reset: BackupResetFlow;
};

export type BackupDeps = {
  /** 書き出す対象の見積り。保存名もここが決める */
  checkExport: (targets: readonly BackupTarget[]) => Promise<BackupExportCheck>;
  /** 書き出しの URL (`<a download>` の href) */
  exportUrl: (targets: readonly BackupTarget[]) => string;
  /** 保存の開始 (DOM を触る唯一の場所) */
  startDownload: (url: string, name: string) => void;
  planRestore: (file: File, targets: readonly BackupTarget[]) => Promise<BackupRestorePlan>;
  applyRestore: (file: File, targets: readonly BackupTarget[]) => Promise<BackupRestoreResult>;
  resetDefinitions: () => Promise<BackupResetResult>;
  /** 復元 / 全削除の後のカタログ取り直し */
  reload: () => void;
  note: (text: string, error: boolean) => void;
};

export type Backup = {
  subscribe: (listener: () => void) => () => void;
  state: () => BackupState;
  exportBackup: (targets: readonly BackupTarget[]) => Promise<void>;
  selectRestoreFile: (file: File) => Promise<void>;
  /** 対象の置き換えを切り替える。同じ ZIP で plan を取り直し、削除チェックを戻す */
  toggleTarget: (target: BackupTarget) => Promise<void>;
  setConfirmed: (value: boolean) => void;
  /** 進行中は何もしない (同じ ZIP を二重に送らない) */
  apply: () => Promise<void>;
  /** 適用中は閉じない (結果とカタログの取り直しを取りこぼさない) */
  closeRestore: () => void;
  openReset: () => void;
  closeReset: () => void;
  applyReset: () => Promise<void>;
};

export const ALL_BACKUP_TARGETS: readonly BackupTarget[] = ["prompts", "agents", "skills"];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `.zip` の拡張子だけで見る。中身の判定は plan の 400 が正で、二重に判定しない */
export function isBackupFileName(name: string): boolean {
  return /\.zip$/i.test(name);
}

export function createBackup(deps: BackupDeps): Backup {
  let current: BackupState = { exporting: false, restore: { status: "idle" }, reset: { status: "idle" } };
  // plan と apply で同じ ZIP を送るため、選ばれた File をここに保持する (画面の状態には載せない)
  let file: File | null = null;
  // 閉じた / 次の plan が始まったあとに届いた応答を捨てる世代
  let generation = 0;
  const listeners = new Set<() => void>();
  const publish = (next: BackupState) => {
    current = next;
    for (const listener of listeners) listener();
  };
  const setRestore = (flow: BackupRestoreFlow) => publish({ ...current, restore: flow });
  const setReset = (flow: BackupResetFlow) => publish({ ...current, reset: flow });

  const exportBackup = async (targets: readonly BackupTarget[]) => {
    if (current.exporting) return;
    publish({ ...current, exporting: true });
    try {
      const check = await deps.checkExport(targets);
      const counts = check.entries.reduce((total, entry) => total + entry.count, 0);
      if (counts === 0) {
        deps.note(BACKUP_EXPORT_EMPTY_NOTE, true);
        return;
      }
      const blocked = check.entries.find((entry) => entry.available === false);
      if (blocked) {
        deps.note(
          `${BACKUP_EXPORT_BLOCKED_NOTE}: ${BACKUP_TARGET_LABELS[blocked.target]}${blocked.reason ? ` (${blocked.reason})` : ""}`,
          true,
        );
        return;
      }
      deps.startDownload(deps.exportUrl(targets), check.fileName);
      deps.note(BACKUP_EXPORT_STARTED_NOTE, false);
    } catch (error) {
      deps.note(errorText(error), true);
    } finally {
      publish({ ...current, exporting: false });
    }
  };

  const planWith = async (selected: readonly BackupTarget[]): Promise<BackupRestorePlan | null> => {
    if (!file) return null;
    const request = ++generation;
    const zip = file;
    setRestore({ status: "planning", fileName: zip.name, selected: [...selected] });
    try {
      const plan = await deps.planRestore(zip, selected);
      if (request !== generation) return null;
      setRestore({ status: "review", fileName: zip.name, selected: [...plan.selected], plan, confirmed: false });
      return plan;
    } catch (error) {
      if (request !== generation) {
        // 古い plan の失敗は捨てる (新しい plan の表示を壊さない)
        return null;
      }
      file = null;
      setRestore({ status: "idle" });
      deps.note(errorText(error), true);
      return null;
    }
  };

  const selectRestoreFile = async (selected: File) => {
    if (current.restore.status !== "idle" && current.restore.status !== "done") return;
    if (!isBackupFileName(selected.name)) {
      deps.note(BACKUP_RESTORE_NOT_ZIP_NOTE, true);
      return;
    }
    file = selected;
    // 対象はまず全部で plan し、応答の manifest.targets で実際に含まれる対象を絞る
    await planWith(ALL_BACKUP_TARGETS);
  };

  const toggleTarget = async (target: BackupTarget) => {
    const flow = current.restore;
    if (flow.status !== "review") return;
    if (!flow.plan.manifest.targets.includes(target)) return;
    const next = flow.selected.includes(target)
      ? flow.selected.filter((item) => item !== target)
      : [...flow.selected, target];
    const ordered = flow.plan.manifest.targets.filter((item) => next.includes(item));
    // 1 つも選ばないと plan を作れないため、最後の 1 つは外せない
    if (ordered.length === 0) return;
    await planWith(ordered);
  };

  const setConfirmed = (value: boolean) => {
    const flow = current.restore;
    if (flow.status !== "review") return;
    setRestore({ ...flow, confirmed: value });
  };

  const apply = async () => {
    const flow = current.restore;
    // 適用中の 2 回目はここで止まる (ボタンは無効だが、Enter 連打でも送らない)
    if (flow.status !== "review" || !file) return;
    if (!backupCanApply(flow.plan, flow.confirmed)) return;
    const request = ++generation;
    const zip = file;
    setRestore({
      status: "applying",
      fileName: flow.fileName,
      selected: flow.selected,
      plan: flow.plan,
      confirmed: flow.confirmed,
    });
    try {
      const result = await deps.applyRestore(zip, flow.selected);
      if (request !== generation) return;
      file = null;
      setRestore({ status: "done", result });
      deps.note(backupRestoreDoneNote(result), !result.complete);
      deps.reload();
    } catch (error) {
      if (request !== generation) return;
      // 409 (ブロッカー / busy) は何も変わっていないので、確認をやり直せる review へ戻す
      setRestore({ ...flow, confirmed: false });
      deps.note(errorText(error), true);
      deps.reload();
    }
  };

  const closeRestore = () => {
    const flow = current.restore;
    if (flow.status === "idle" || flow.status === "applying") return;
    generation += 1;
    file = null;
    setRestore({ status: "idle" });
  };

  const applyReset = async () => {
    if (current.reset.status !== "confirm") return;
    setReset({ status: "applying" });
    try {
      const result = await deps.resetDefinitions();
      setReset({ status: "done", result });
      deps.note(backupResetDoneNote(result), !result.complete);
      deps.reload();
    } catch (error) {
      setReset({ status: "confirm" });
      deps.note(errorText(error), true);
    }
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    state: () => current,
    exportBackup,
    selectRestoreFile,
    toggleTarget,
    setConfirmed,
    apply,
    closeRestore,
    openReset: () => {
      if (current.reset.status === "idle" || current.reset.status === "done") setReset({ status: "confirm" });
    },
    closeReset: () => {
      if (current.reset.status === "applying") return;
      setReset({ status: "idle" });
    },
    applyReset,
  };
}
