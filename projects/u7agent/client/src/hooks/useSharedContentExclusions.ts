import { getSharedContentExclusions, resetSharedContentExclusions, updateSharedContentExclusions } from "../api";
import { validateSharedContentExcludeNames } from "../lib/sharedContentExclusions";
import type { SharedContentExclusionsResponse } from "../types";
import { useExcludeNamesSettings, type ExcludeNamesSettings } from "./useExcludeNamesSettings";

const LOAD_ERROR = "公開の除外名を読み込めませんでした。";
const SAVED_NOTE = "公開の除外名を保存しました。";

/**
 * 設定 → 共有「公開の除外」の state と操作。ダウンロードの除外とは別の行・別の既定を持つので、
 * 編集の手順はアーカイブの設定と共有し、API と検証と文言だけをここに残す。
 */
export function useSharedContentExclusions(): ExcludeNamesSettings<SharedContentExclusionsResponse> {
  return useExcludeNamesSettings({
    loadErrorLabel: LOAD_ERROR,
    load: getSharedContentExclusions,
    save: updateSharedContentExclusions,
    reset: resetSharedContentExclusions,
    savedNote: SAVED_NOTE,
    validate: validateSharedContentExcludeNames,
  });
}

export type SharedContentExclusionsSettings = ExcludeNamesSettings<SharedContentExclusionsResponse>;
