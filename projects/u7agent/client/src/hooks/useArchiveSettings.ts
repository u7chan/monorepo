import { getArchiveSettings, resetArchiveSettings, updateArchiveSettings } from "../api";
import { validateExcludeNames } from "../lib/archiveSettings";
import type { ArchiveSettingsResponse } from "../types";
import { useExcludeNamesSettings, type ExcludeNamesSettings } from "./useExcludeNamesSettings";

const LOAD_ERROR = "ダウンロードの除外名を読み込めませんでした。";
const SAVED_NOTE = "ダウンロードの除外名を保存しました。";

/**
 * アーカイブの除外名の state と操作。行の出し分け（ツリーのダウンロードボタン）が保存の直後に追随する必要があるため、
 * 設定ページを開いていなくても facade（useU7Agent）が起動時に読み込み、画面とツリーで同じ実効値を見る。
 */
export function useArchiveSettings(): ExcludeNamesSettings<ArchiveSettingsResponse> {
  return useExcludeNamesSettings({
    loadErrorLabel: LOAD_ERROR,
    load: getArchiveSettings,
    save: updateArchiveSettings,
    reset: resetArchiveSettings,
    savedNote: SAVED_NOTE,
    validate: validateExcludeNames,
  });
}

export type ArchiveSettings = ExcludeNamesSettings<ArchiveSettingsResponse>;
