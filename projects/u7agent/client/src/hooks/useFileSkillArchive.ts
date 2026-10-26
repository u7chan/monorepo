import { useRef, useState, useSyncExternalStore } from "react";
import { applySkillsImport, getSkillsExportCheck, planSkillsImport, skillsExportUrl } from "../api";
import { startArchiveDownload } from "../lib/archive";
import { createSkillArchive, type SkillArchiveState } from "../lib/skillArchive";

export type FileSkillArchiveOptions = {
  /** 一覧 (GET /api/skills/files) の取り直し */
  reloadSkills: () => void;
  /** インポートしたスキルを開く (選択と本文の取得) */
  selectSkill: (relativePath: string) => void;
  note: (text: string, error?: boolean) => void;
};

export type FileSkillArchive = SkillArchiveState & {
  exportSkills: () => Promise<void>;
  selectImportFile: (file: File) => Promise<void>;
  toggleReplace: (name: string) => void;
  setReplaceAll: (selected: boolean) => void;
  applyImport: () => Promise<void>;
  closeImport: () => void;
};

/**
 * エクスポート / インポートの流れを画面へ繋ぐ。流れと判定は lib/skillArchive.ts が持ち、ここは API と DOM の
 * 入口を注入して、購読した状態を返すだけにする。画面のコールバックは最新の props を使う。
 */
export function useFileSkillArchive({ reloadSkills, selectSkill, note }: FileSkillArchiveOptions): FileSkillArchive {
  // 最新の props を参照する (流れは 1 度だけ作るため、古い閉包を握らせない)
  const latest = useRef({ reloadSkills, selectSkill, note });
  latest.current = { reloadSkills, selectSkill, note };
  const [archive] = useState(() =>
    createSkillArchive({
      checkExport: getSkillsExportCheck,
      exportUrl: skillsExportUrl(),
      startDownload: startArchiveDownload,
      planImport: planSkillsImport,
      applyImport: applySkillsImport,
      reloadSkills: () => latest.current.reloadSkills(),
      selectSkill: (relativePath) => latest.current.selectSkill(relativePath),
      note: (text, error) => latest.current.note(text, error),
    }),
  );
  const state = useSyncExternalStore(archive.subscribe, archive.state, archive.state);
  return {
    ...state,
    exportSkills: archive.exportSkills,
    selectImportFile: archive.selectImportFile,
    toggleReplace: archive.toggleReplace,
    setReplaceAll: archive.setReplaceAll,
    applyImport: archive.applyImport,
    closeImport: archive.closeImport,
  };
}
