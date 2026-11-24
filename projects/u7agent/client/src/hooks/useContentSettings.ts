import { useCallback } from "react";
import {
  deleteContentApiKey,
  getContentSettings,
  putContentApiKey,
  putContentCost,
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
  CONTENT_COST_SAVED_NOTE,
  contentImageProviderNote,
  contentCatalogRefreshNote,
  contentEnabledNote,
  type ContentSavingAction,
} from "../lib/contentSettings";
import { validateApiKey } from "../lib/modelSettings";
import { messageFor } from "../lib/errors";
import type {
  ContentSettingsResponse,
  ImageGenerationProvider,
  UpdateContentCostBody,
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
   * 注記は失敗した系統だけを、一覧と価格のどちらが変わらないかを分けて出す。
   */
  const refreshCatalog = useCallback(async (): Promise<boolean> => {
    setSaving("catalog");
    try {
      const response = await refreshContentCatalog();
      const { errors, ...snapshot } = response;
      invalidatePendingLoads();
      setSettings(snapshot);
      const failed = [contentCatalogRefreshNote("image", errors), contentCatalogRefreshNote("speech", errors)].filter(
        (notice) => notice.error,
      );
      setNote({
        text: failed.length === 0 ? "モデル一覧を取得しました。" : failed.map((notice) => notice.text).join(" "),
        error: failed.length > 0,
      });
      return failed.length === 0;
    } catch (error) {
      setNote({ text: `モデル一覧を取得できませんでした。${messageFor(error)}`, error: true });
      return false;
    } finally {
      setSaving(null);
    }
  }, [invalidatePendingLoads, setNote, setSaving, setSettings]);

  /** コストマスタの接続先とトグル。取得しないため、保存後に [カタログ更新] を待つ */
  const saveCost = useCallback(
    (input: UpdateContentCostBody): Promise<boolean> =>
      runMutation("cost", CONTENT_COST_SAVED_NOTE, () => putContentCost(input)),
    [runMutation],
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
    saveCost,
    refreshCatalog,
  };
}

export type ContentSettings = ReturnType<typeof useContentSettings>;
