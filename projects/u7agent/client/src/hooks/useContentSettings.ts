import { useCallback, useState } from "react";
import {
  deleteContentApiKey,
  getContentSettings,
  putContentApiKey,
  putContentEnabled,
  putContentImageProvider,
  putContentImageSettings,
  putContentSpeechSettings,
  refreshContentCatalog,
} from "../api";
import {
  CONTENT_KEY_DELETED_NOTE,
  CONTENT_KEY_SAVED_NOTE,
  CONTENT_IMAGE_SAVED_NOTE,
  CONTENT_SETTINGS_NOTE,
  CONTENT_SPEECH_SAVED_NOTE,
  contentImageProviderNote,
  catalogRefreshNote,
  contentEnabledNote,
  type ContentSavingAction,
} from "../lib/contentSettings";
import { validateApiKey } from "../lib/modelSettings";
import { messageFor } from "../lib/settingsResource";
import type {
  ContentSettingsResponse,
  ImageGenerationProvider,
  UpdateContentImageBody,
  UpdateContentSpeechBody,
} from "../types";
import { useSettingsResource } from "./useSettingsResource";

/**
 * 設定 → コンテンツ生成の state と操作。GET はこの画面を開いたときだけ取り、
 * 変更系の応答は GET と同じ形なので、注記を付けてそのまま次の状態にできる。
 * SDK への認証反映を持たないため、health / カタログの再取得は通さない。
 */
export function useContentSettings() {
  /** 音声の表示が server の実効値と一致しているか。再取得後の確認に失敗すると false になり、保存を止める */
  const [speechSynced, setSpeechSynced] = useState(true);
  // 読み込み / 変更の応答は server の現在値なので、音声の表示も同期済みにする
  const markSpeechSynced = useCallback(() => setSpeechSynced(true), []);
  const {
    settings,
    note,
    saving,
    reloading,
    reload,
    runMutation,
    setSettings,
    setNote,
    setSaving,
    invalidatePendingLoads,
  } = useSettingsResource<ContentSettingsResponse, ContentSavingAction>({
    defaultNote: CONTENT_SETTINGS_NOTE,
    loadErrorLabel: "コンテンツ生成の設定を読み込めませんでした。",
    load: getContentSettings,
    onApply: markSpeechSynced,
  });

  /**
   * 有効 / 無効。保存するとツールの公開状態が変わるため、画面は成功後にエージェントのツール一覧を
   * 取り直す（エージェント編集のツール欄が取得時点のスナップショットを見るため）。
   */
  const setEnabled = useCallback(
    (enabled: boolean): Promise<boolean> =>
      runMutation("enabled", contentEnabledNote(enabled), () => putContentEnabled(enabled)),
    [runMutation],
  );

  const saveKey = useCallback(
    async (apiKey: string): Promise<boolean> => {
      const invalid = validateApiKey(apiKey);
      if (invalid) {
        setNote({ text: invalid, error: true });
        return false;
      }
      return runMutation("key", CONTENT_KEY_SAVED_NOTE, () => putContentApiKey(apiKey));
    },
    [runMutation, setNote],
  );

  const removeKey = useCallback(
    (): Promise<boolean> => runMutation("delete", CONTENT_KEY_DELETED_NOTE, () => deleteContentApiKey()),
    [runMutation],
  );

  /**
   * 画像の生成元。キーもモデルも伴わないが、ツール一覧の公開状態が変わるため、保存できたら
   * エージェントのツール一覧も取り直す（画面は保存後に呼ぶ）。
   */
  const saveImageProvider = useCallback(
    (provider: ImageGenerationProvider): Promise<boolean> =>
      runMutation("provider", contentImageProviderNote(provider), () => putContentImageProvider({ provider })),
    [runMutation],
  );

  const saveSelection = useCallback(
    (input: UpdateContentImageBody): Promise<boolean> =>
      runMutation("selection", CONTENT_IMAGE_SAVED_NOTE, () => putContentImageSettings(input)),
    [runMutation],
  );

  const saveSpeech = useCallback(
    (input: UpdateContentSpeechBody): Promise<boolean> =>
      runMutation("speech", CONTENT_SPEECH_SAVED_NOTE, () => putContentSpeechSettings(input)),
    [runMutation],
  );

  /**
   * モデル一覧と価格の再取得。応答は GET と同じ形なので、そのまま次の状態にする
   * （GET と同じ形の応答を待っている別の読み込みに上書きさせないため、invalidatePendingLoads で無効化する）。
   * 注記は面に応じて、その面が読む系統の失敗だけを出す。
   */
  const refreshCatalogState = useCallback(
    async (systems: readonly ("image" | "speech" | "cost")[]): Promise<boolean> => {
      setSaving(systems.includes("speech") ? "speech-catalog" : "catalog");
      try {
        const response = await refreshContentCatalog();
        const { errors, ...snapshot } = response;
        invalidatePendingLoads();
        setSettings(snapshot);
        // 応答はサーバーの現在値そのものなので、一覧の並びが変わっても表示の同期は崩れない
        setSpeechSynced(true);
        const messages = systems
          .map((system) => errors[system])
          .filter((message): message is string => typeof message === "string");
        setNote({
          text: catalogRefreshNote(messages.length === 0 ? null : messages.join("。")),
          error: messages.length > 0,
        });
        return messages.length === 0;
      } catch (error) {
        setNote({ text: `モデル一覧を取得できませんでした。${messageFor(error)}`, error: true });
        return false;
      } finally {
        setSaving(null);
      }
    },
    [invalidatePendingLoads, setNote, setSaving, setSettings],
  );

  const refreshCatalog = useCallback(
    (): Promise<boolean> => refreshCatalogState(["image", "cost"]),
    [refreshCatalogState],
  );

  const refreshSpeechCatalog = useCallback(
    (): Promise<boolean> => refreshCatalogState(["speech"]),
    [refreshCatalogState],
  );

  return {
    settings,
    note,
    saving,
    reloading,
    reload,
    setEnabled,
    saveKey,
    removeKey,
    saveImageProvider,
    saveSelection,
    saveSpeech,
    refreshCatalog,
    refreshSpeechCatalog,
    speechSynced,
  };
}

export type ContentSettings = ReturnType<typeof useContentSettings>;
