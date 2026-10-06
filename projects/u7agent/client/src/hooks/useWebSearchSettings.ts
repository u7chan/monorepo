import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  deleteWebSearchApiKey,
  getWebSearchSettings,
  putWebSearchApiKey,
  putWebSearchProvider,
  putWebSearchSettings,
} from "../api";
import {
  WEB_SEARCH_SETTINGS_NOTE,
  webSearchKeyDeletedNote,
  webSearchKeySavedNote,
  webSearchProviderSavedNote,
  webSearchSavedNote,
  type WebSearchSavingAction,
} from "../lib/webSearchSettings";
import { validateApiKey } from "../lib/modelSettings";
import type { WebSearchProviderId, WebSearchSettingsResponse } from "../types";
import { createLoadingTracker, createRequestGate } from "./requestGate";

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 応答の provider 一覧から表示名を引く。未知でも id を出して操作を止めない */
function providerName(response: WebSearchSettingsResponse, provider: WebSearchProviderId): string {
  return response.providers.find((entry) => entry.id === provider)?.name ?? provider;
}

/**
 * 設定 → モデル（Web 検索タブ）の state と操作。GET はこの画面を開いたときだけ取り、
 * 変更系の応答は GET と同じ形なので、注記を付けてそのまま次の状態にできる。
 * 保存は「その場で効く」前提なので、失敗したら状態を変えずに理由だけを出す。
 */
export function useWebSearchSettings() {
  const [settings, setSettings] = useState<WebSearchSettingsResponse | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean }>({
    text: WEB_SEARCH_SETTINGS_NOTE,
    error: false,
  });
  const [saving, setSaving] = useState<WebSearchSavingAction | null>(null);
  const [reloading, setReloading] = useState(false);
  const [beginLoad] = useState(createRequestGate);
  // 破棄された取得でも進行中を解除するため、適用の可否とは別に追う
  const [reloadTracker] = useState(() => createLoadingTracker(setReloading));

  const reload = useCallback(async (): Promise<void> => {
    const canApply = beginLoad();
    const finishReload = reloadTracker.begin();
    try {
      const next = await getWebSearchSettings();
      if (!canApply()) return;
      setSettings(next);
      setNote({ text: WEB_SEARCH_SETTINGS_NOTE, error: false });
    } catch (error) {
      if (canApply()) {
        setNote({ text: `Web 検索の設定を読み込めませんでした。${messageFor(error)}`, error: true });
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
      action: WebSearchSavingAction,
      successNote: (response: WebSearchSettingsResponse) => string,
      run: () => Promise<WebSearchSettingsResponse>,
    ): Promise<boolean> => {
      setSaving(action);
      try {
        const response = await run();
        // 進行中の読み込みの応答で、いま適用した応答を上書きさせない
        beginLoad();
        setSettings(response);
        setNote({ text: successNote(response), error: false });
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

  const setEnabled = useCallback(
    (enabled: boolean): Promise<boolean> =>
      runMutation(
        "enabled",
        (response) => webSearchSavedNote(response.enabled),
        () => putWebSearchSettings(enabled),
      ),
    [runMutation],
  );

  const setProvider = useCallback(
    (provider: WebSearchProviderId): Promise<boolean> =>
      runMutation(
        "provider",
        (response) => webSearchProviderSavedNote(providerName(response, provider)),
        () => putWebSearchProvider(provider),
      ),
    [runMutation],
  );

  const saveKey = useCallback(
    (provider: WebSearchProviderId, apiKey: string): Promise<boolean> => {
      const invalid = validateApiKey(apiKey);
      if (invalid) {
        setNote({ text: invalid, error: true });
        return Promise.resolve(false);
      }
      return runMutation(
        "key",
        (response) => webSearchKeySavedNote(providerName(response, provider)),
        () => putWebSearchApiKey(provider, apiKey),
      );
    },
    [runMutation],
  );

  const removeKey = useCallback(
    (provider: WebSearchProviderId): Promise<boolean> =>
      runMutation(
        "delete",
        (response) => webSearchKeyDeletedNote(providerName(response, provider)),
        () => deleteWebSearchApiKey(provider),
      ),
    [runMutation],
  );

  return { settings, note, saving, reloading, reload, setEnabled, setProvider, saveKey, removeKey };
}

export type WebSearchSettings = ReturnType<typeof useWebSearchSettings>;
