import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  deleteContentApiKey,
  getContentSettings,
  putContentApiKey,
  putContentImageSettings,
  putContentSpeechSettings,
  refreshImageCatalog,
  refreshSpeechCatalog as requestSpeechCatalogRefresh,
} from "../api";
import {
  CONTENT_KEY_DELETED_NOTE,
  CONTENT_KEY_SAVED_NOTE,
  CONTENT_MODEL_SAVED_NOTE,
  CONTENT_SETTINGS_NOTE,
  CONTENT_SPEECH_SAVED_NOTE,
  SPEECH_SYNC_FAILED_NOTE,
  catalogRefreshNote,
  speechSettingsAfterRefresh,
  speechSyncedAfterRefresh,
  type ContentSavingAction,
} from "../lib/contentSettings";
import { validateApiKey } from "../lib/modelSettings";
import type { ContentSettingsResponse, UpdateContentImageBody, UpdateContentSpeechBody } from "../types";
import { createLoadingTracker, createRequestGate } from "./requestGate";

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 設定 → モデル（コンテンツ生成タブ）の state と操作。GET はこの画面を開いたときだけ取り、
 * 変更系の応答は GET と同じ形なので、注記を付けてそのまま次の状態にできる。
 * SDK への認証反映を持たないため、health / カタログの再取得は通さない。
 */
export function useContentSettings() {
  const [settings, setSettings] = useState<ContentSettingsResponse | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean }>({ text: CONTENT_SETTINGS_NOTE, error: false });
  const [saving, setSaving] = useState<ContentSavingAction | null>(null);
  const [reloading, setReloading] = useState(false);
  /** 音声の表示が server の実効値と一致しているか。再取得後の確認に失敗すると false になり、保存を止める */
  const [speechSynced, setSpeechSynced] = useState(true);
  const [beginLoad] = useState(createRequestGate);
  // 破棄された取得でも進行中を解除するため、適用の可否とは別に追う
  const [reloadTracker] = useState(() => createLoadingTracker(setReloading));

  const reload = useCallback(async (): Promise<void> => {
    const canApply = beginLoad();
    const finishReload = reloadTracker.begin();
    try {
      const next = await getContentSettings();
      if (!canApply()) return;
      setSettings(next);
      setSpeechSynced(true);
      setNote({ text: CONTENT_SETTINGS_NOTE, error: false });
    } catch (error) {
      if (canApply()) {
        setNote({ text: `コンテンツ生成の設定を読み込めませんでした。${messageFor(error)}`, error: true });
      }
    } finally {
      finishReload();
    }
  }, [beginLoad, reloadTracker]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const runMutation = useCallback(
    async (
      action: ContentSavingAction,
      successNote: string,
      run: () => Promise<ContentSettingsResponse>,
    ): Promise<boolean> => {
      setSaving(action);
      try {
        const response = await run();
        // 進行中の読み込みの応答で、いま適用した応答を上書きさせない
        beginLoad();
        setSettings(response);
        // 変更系の応答は server の現在値なので、音声の表示も同期済みにする
        setSpeechSynced(true);
        setNote({ text: successNote, error: false });
        return true;
      } catch (error) {
        // 何も保存されなかった (503 not_stored / 400) ことを文言で区別する
        const prefix = error instanceof ApiError && error.state === "not_stored" ? "変更は保存されていません。" : "";
        setNote({ text: `${prefix}${messageFor(error)}`, error: true });
        return false;
      } finally {
        setSaving(null);
      }
    },
    [beginLoad],
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
    [runMutation],
  );

  const removeKey = useCallback(
    (): Promise<boolean> => runMutation("delete", CONTENT_KEY_DELETED_NOTE, () => deleteContentApiKey()),
    [runMutation],
  );

  const saveSelection = useCallback(
    (input: UpdateContentImageBody): Promise<boolean> =>
      runMutation("selection", CONTENT_MODEL_SAVED_NOTE, () => putContentImageSettings(input)),
    [runMutation],
  );

  const saveSpeech = useCallback(
    (input: UpdateContentSpeechBody): Promise<boolean> =>
      runMutation("speech", CONTENT_SPEECH_SAVED_NOTE, () => putContentSpeechSettings(input)),
    [runMutation],
  );

  /**
   * モデル一覧の再取得。設定は変わらないので、一覧と出どころだけを差し替える
   * （GET と同じ形の応答を待っている別の読み込みに上書きさせないため、beginLoad で無効化する）。
   */
  const refreshCatalog = useCallback(async (): Promise<boolean> => {
    setSaving("catalog");
    try {
      const response = await refreshImageCatalog();
      beginLoad();
      setSettings((previous) =>
        previous === null
          ? previous
          : {
              ...previous,
              image: {
                ...previous.image,
                models: response.models,
                catalogSource: response.catalogSource,
                fetchedAt: response.fetchedAt,
              },
            },
      );
      setNote({ text: catalogRefreshNote(response.catalogError), error: response.catalogError !== null });
      return response.catalogError === null;
    } catch (error) {
      setNote({ text: `モデル一覧を取得できませんでした。${messageFor(error)}`, error: true });
      return false;
    } finally {
      setSaving(null);
    }
  }, [beginLoad]);

  /**
   * 音声モデル一覧の再取得。形も失敗の扱いも画像と同じだが、一覧の並びが変わると NULL ボイスの
   * フォールバック（先頭）も変わるため、表示を server の現在値へ合わせる。確認できないまま
   * 古い表示を現在値として扱うと実行時の解決と食い違うので、その間は保存を止める。
   */
  const refreshSpeechCatalog = useCallback(async (): Promise<boolean> => {
    setSaving("speech-catalog");
    try {
      const response = await requestSpeechCatalogRefresh();
      beginLoad();
      let current: ContentSettingsResponse | null = null;
      try {
        current = await getContentSettings();
      } catch {
        // 一覧は取れているので、選べる候補だけを新しいものへ差し替える（下で同期状態を落とす）
      }
      const synced = speechSyncedAfterRefresh(response, current);
      beginLoad();
      setSettings((previous) => speechSettingsAfterRefresh(previous, response, current));
      setSpeechSynced(synced);
      setNote(
        synced
          ? { text: catalogRefreshNote(response.catalogError), error: response.catalogError !== null }
          : { text: SPEECH_SYNC_FAILED_NOTE, error: true },
      );
      return synced && response.catalogError === null;
    } catch (error) {
      setNote({ text: `モデル一覧を取得できませんでした。${messageFor(error)}`, error: true });
      return false;
    } finally {
      setSaving(null);
    }
  }, [beginLoad]);

  return {
    settings,
    note,
    saving,
    reloading,
    reload,
    saveKey,
    removeKey,
    saveSelection,
    saveSpeech,
    refreshCatalog,
    refreshSpeechCatalog,
    speechSynced,
  };
}

export type ContentSettings = ReturnType<typeof useContentSettings>;
