/**
 * 共通スキル (`.agents/skills`) の持ち出し / 取り込みの流れ。plan の分類と選択の状態遷移をここへ閉じ、
 * 通信と DOM (保存の開始) は注入された deps だけを触る。画面は購読した状態を描画するだけにする
 * (docs/api-catalog.md)。
 */
import {
  SKILL_EXPORT_EMPTY_NOTE,
  SKILL_EXPORT_STARTED_NOTE,
  SKILL_IMPORT_NOT_ZIP_NOTE,
  skillImportDoneNote,
} from "./fileSkills";
import type { FileDownloadCheck, SandboxSkillsImportApply, SandboxSkillsImportPlan } from "../types";

/** 取り込みの段階。plan は何も変更せず、適用するのは review で選んだ分だけ */
export type SkillImportFlow =
  | { status: "idle" }
  | { status: "planning"; fileName: string }
  | { status: "review"; fileName: string; plan: SandboxSkillsImportPlan; replace: string[] }
  | { status: "applying"; fileName: string; plan: SandboxSkillsImportPlan; replace: string[] }
  | { status: "applied"; fileName: string; result: SandboxSkillsImportApply };

export type SkillArchiveState = {
  /** 持ち出しの check を送っている間だけ true (二重に送らない) */
  exporting: boolean;
  import: SkillImportFlow;
};

export type SkillArchiveDeps = {
  checkExport: () => Promise<FileDownloadCheck>;
  /** 持ち出しの URL (`<a download>` の href) */
  exportUrl: string;
  /** 保存の開始 (DOM を触る唯一の場所) */
  startDownload: (url: string, name: string) => void;
  planImport: (file: File) => Promise<SandboxSkillsImportPlan>;
  /** plan と同じ File をそのまま渡す */
  applyImport: (file: File, replace: readonly string[]) => Promise<SandboxSkillsImportApply>;
  /** 一覧 (GET /api/skills/files) の取り直し */
  reloadSkills: () => void;
  /** 取り込んだスキルを開く。ダイアログの下で開かないよう、閉じてから呼ぶ */
  selectSkill: (relativePath: string) => void;
  note: (text: string, error: boolean) => void;
};

export type SkillArchive = {
  /** useSyncExternalStore の購読 */
  subscribe: (listener: () => void) => () => void;
  /** useSyncExternalStore の snapshot。変更が無い間は同じ参照を返す */
  state: () => SkillArchiveState;
  exportSkills: () => Promise<void>;
  selectImportFile: (file: File) => Promise<void>;
  toggleReplace: (name: string) => void;
  setReplaceAll: (selected: boolean) => void;
  /** 進行中は何もしない (同じ ZIP を二重に送らない) */
  applyImport: () => Promise<void>;
  /** 適用中は閉じない (結果と一覧の取り直しを取りこぼさない) */
  closeImport: () => void;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 選択できるのは conflict の行だけ。名前は plan の順を保つ (全選択の並びを応答から決める) */
export function replaceableSkillNames(plan: SandboxSkillsImportPlan): string[] {
  return plan.skills.filter((skill) => skill.status === "conflict").map((skill) => skill.name);
}

/** new は常に取り込み、identical / invalid は常に対象外で、conflict は選択された分だけ取り込む */
export function skillImportCounts(
  plan: SandboxSkillsImportPlan,
  replace: readonly string[],
): { imported: number; replaced: number } {
  const added = plan.skills.filter((skill) => skill.status === "new").length;
  const replaced = plan.skills.filter((skill) => skill.status === "conflict" && replace.includes(skill.name)).length;
  return { imported: added + replaced, replaced };
}

/**
 * 選ばれた名前を `.zip` の拡張子だけで見る。中身の判定は plan の status と 400 (ZIP でない / 構造不正) が
 * 正で、二重に判定しない (壊れた ZIP を選んでも理由はサーバーがそのまま返す)。
 */
export function isSkillArchiveFileName(name: string): boolean {
  return /\.zip$/i.test(name);
}

export function createSkillArchive(deps: SkillArchiveDeps): SkillArchive {
  let current: SkillArchiveState = { exporting: false, import: { status: "idle" } };
  // plan と apply で同じ ZIP を送るため、選ばれた File をここに保持する (画面の状態には載せない)
  let file: File | null = null;
  // 閉じた / 次の取り込みが始まったあとに届いた応答を捨てる世代
  let generation = 0;
  const listeners = new Set<() => void>();
  const publish = (next: SkillArchiveState) => {
    current = next;
    for (const listener of listeners) listener();
  };
  const setImport = (flow: SkillImportFlow) => publish({ ...current, import: flow });

  const exportSkills = async () => {
    if (current.exporting) return;
    publish({ ...current, exporting: true });
    try {
      const check = await deps.checkExport();
      // 413 (上限超過) と 404 (`.agents/skills` が無い) は失敗として理由をそのまま出す
      if (check.entries === 0) {
        deps.note(SKILL_EXPORT_EMPTY_NOTE, true);
        return;
      }
      deps.startDownload(deps.exportUrl, check.name);
      deps.note(SKILL_EXPORT_STARTED_NOTE, false);
    } catch (error) {
      deps.note(errorText(error), true);
    } finally {
      publish({ ...current, exporting: false });
    }
  };

  const selectImportFile = async (selected: File) => {
    if (current.import.status !== "idle") return;
    if (!isSkillArchiveFileName(selected.name)) {
      deps.note(SKILL_IMPORT_NOT_ZIP_NOTE, true);
      return;
    }
    const request = ++generation;
    file = selected;
    setImport({ status: "planning", fileName: selected.name });
    try {
      const plan = await deps.planImport(selected);
      if (request !== generation) return;
      // 既定では 1 つも置き換えない (選ぶのは conflict の行だけ)
      setImport({ status: "review", fileName: selected.name, plan, replace: [] });
    } catch (error) {
      if (request !== generation) return;
      file = null;
      setImport({ status: "idle" });
      deps.note(errorText(error), true);
    }
  };

  const toggleReplace = (name: string) => {
    const flow = current.import;
    if (flow.status !== "review") return;
    if (!replaceableSkillNames(flow.plan).includes(name)) return;
    const replace = flow.replace.includes(name)
      ? flow.replace.filter((item) => item !== name)
      : [...flow.replace, name];
    setImport({ ...flow, replace });
  };

  const setReplaceAll = (selected: boolean) => {
    const flow = current.import;
    if (flow.status !== "review") return;
    setImport({ ...flow, replace: selected ? replaceableSkillNames(flow.plan) : [] });
  };

  const applyImport = async () => {
    const flow = current.import;
    // 適用中の 2 回目はここで止まる (ボタンは無効だが、Enter 連打でも送らない)
    if (flow.status !== "review" || !file) return;
    const request = ++generation;
    const zip = file;
    const replace = flow.replace;
    setImport({ ...flow, status: "applying" });
    try {
      const result = await deps.applyImport(zip, replace);
      if (request !== generation) return;
      file = null;
      setImport({ status: "applied", fileName: flow.fileName, result });
      deps.note(skillImportDoneNote(result.applied.length, result.skipped.length), false);
      deps.reloadSkills();
    } catch (error) {
      if (request !== generation) return;
      file = null;
      setImport({ status: "idle" });
      deps.note(errorText(error), true);
      // 部分適用の結果は出さない。サーバーが巻き戻す前提で、一覧だけ取り直す
      deps.reloadSkills();
    }
  };

  const closeImport = () => {
    const flow = current.import;
    if (flow.status === "idle" || flow.status === "applying") return;
    generation += 1;
    file = null;
    setImport({ status: "idle" });
    if (flow.status === "applied") {
      const imported = flow.result.applied[0];
      if (imported) deps.selectSkill(imported.relativePath);
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
    exportSkills,
    selectImportFile,
    toggleReplace,
    setReplaceAll,
    applyImport,
    closeImport,
  };
}
