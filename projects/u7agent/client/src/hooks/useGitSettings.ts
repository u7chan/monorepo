import { useCallback } from "react";
import { deleteGitSettings, getGitSettings, putGitSettings } from "../api";
import {
  GIT_SETTINGS_CLEARED_NOTE,
  GIT_SETTINGS_LOAD_ERROR,
  GIT_SETTINGS_NOTE,
  GIT_SETTINGS_SAVED_NOTE,
  gitIdentityInputProblem,
} from "../lib/gitSettings";
import { useSettingsResource } from "./useSettingsResource";

export type GitSettingsAction = "save" | "clear";

/**
 * 設定 → Git の state と操作。GET はこの画面を開いたときだけ取り、変更系の応答は GET と同じ形なので
 * そのまま次の状態にできる。両方必須の規則はサーバーが正で、ここは保存前に同じ理由を出す。
 */
export function useGitSettings() {
  const { settings, note, saving, reloading, reload, runMutation, setNote } = useSettingsResource<
    Awaited<ReturnType<typeof getGitSettings>>,
    GitSettingsAction
  >({
    defaultNote: GIT_SETTINGS_NOTE,
    loadErrorLabel: GIT_SETTINGS_LOAD_ERROR,
    load: getGitSettings,
  });

  const save = useCallback(
    (userName: string, userEmail: string): Promise<boolean> => {
      const problem = gitIdentityInputProblem(userName, userEmail);
      if (problem) {
        setNote({ text: problem, error: true });
        return Promise.resolve(false);
      }
      return runMutation("save", GIT_SETTINGS_SAVED_NOTE, () => putGitSettings(userName.trim(), userEmail.trim()));
    },
    [runMutation, setNote],
  );

  const clear = useCallback(
    (): Promise<boolean> => runMutation("clear", GIT_SETTINGS_CLEARED_NOTE, deleteGitSettings),
    [runMutation],
  );

  return { settings, note, saving, reloading, reload, save, clear };
}

export type GitSettings = ReturnType<typeof useGitSettings>;
