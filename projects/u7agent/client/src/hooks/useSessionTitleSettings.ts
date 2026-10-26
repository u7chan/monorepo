import { useCallback } from "react";
import { getTitleSummarySettings, putTitleSummarySettings } from "../api";
import {
  SESSION_TITLE_DEFINITION_RESET_NOTE,
  SESSION_TITLE_DEFINITION_SAVED_NOTE,
  SESSION_TITLE_EFFORT_SAVED_NOTE,
  SESSION_TITLE_MODEL_SAVED_NOTE,
  SESSION_TITLE_SETTINGS_NOTE,
  sessionTitleDefinitionError,
  sessionTitleSavedNote,
  type SessionTitleSavingAction,
} from "../lib/sessionTitleSettings";
import type { ThinkingLevel, TitleSummarySettingsResponse } from "../types";
import { useSettingsResource } from "./useSettingsResource";

/**
 * 設定 → 会話タイトルの state と操作。GET はこの画面を開いたときだけ取り、
 * 変更系の応答は GET と同じ形なので、そのまま次の状態にできる。
 * モデル未選択のまま On にできない規則はサーバーが正で、ここは保存前に同じ理由を出す。
 */
export function useSessionTitleSettings() {
  const { settings, note, saving, reloading, reload, runMutation, setNote } = useSettingsResource<
    TitleSummarySettingsResponse,
    SessionTitleSavingAction
  >({
    defaultNote: SESSION_TITLE_SETTINGS_NOTE,
    loadErrorLabel: "会話タイトルの設定を読み込めませんでした。",
    load: getTitleSummarySettings,
  });

  const setEnabled = useCallback(
    (enabled: boolean): Promise<boolean> => {
      if (enabled && !settings?.model) {
        setNote({ text: "AI要約を有効にするには、先に要約モデルを選択してください。", error: true });
        return Promise.resolve(false);
      }
      return runMutation(
        "enabled",
        (response) => sessionTitleSavedNote(response),
        () => putTitleSummarySettings({ enabled }),
      );
    },
    [runMutation, setNote, settings?.model],
  );

  const setModel = useCallback(
    (model: string, thinkingLevel?: ThinkingLevel | null): Promise<boolean> =>
      runMutation(
        "model",
        () => SESSION_TITLE_MODEL_SAVED_NOTE,
        () =>
          putTitleSummarySettings({
            enabled: settings?.enabled ?? false,
            model,
            ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
          }),
      ),
    [runMutation, settings?.enabled],
  );

  const setEffort = useCallback(
    (thinkingLevel: ThinkingLevel): Promise<boolean> =>
      runMutation(
        "effort",
        () => SESSION_TITLE_EFFORT_SAVED_NOTE,
        () => putTitleSummarySettings({ enabled: settings?.enabled ?? false, thinkingLevel }),
      ),
    [runMutation, settings?.enabled],
  );

  const saveDefinition = useCallback(
    (definition: string): Promise<boolean> => {
      const invalid = sessionTitleDefinitionError(definition);
      if (invalid) {
        setNote({ text: invalid, error: true });
        return Promise.resolve(false);
      }
      return runMutation(
        "definition",
        () => SESSION_TITLE_DEFINITION_SAVED_NOTE,
        () => putTitleSummarySettings({ enabled: settings?.enabled ?? false, definition: definition.trim() }),
      );
    },
    [runMutation, setNote, settings?.enabled],
  );

  const resetDefinition = useCallback(
    (): Promise<boolean> =>
      runMutation(
        "reset",
        () => SESSION_TITLE_DEFINITION_RESET_NOTE,
        () =>
          putTitleSummarySettings({
            enabled: settings?.enabled ?? false,
            definition: settings?.defaultDefinition ?? "",
          }),
      ),
    [runMutation, settings?.defaultDefinition, settings?.enabled],
  );

  return {
    settings,
    note,
    saving,
    reloading,
    reload,
    setEnabled,
    setModel,
    setEffort,
    saveDefinition,
    resetDefinition,
  };
}

export type SessionTitleSettings = ReturnType<typeof useSessionTitleSettings>;
