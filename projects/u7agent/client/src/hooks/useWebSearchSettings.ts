import { useCallback } from "react";
import {
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
import { useSettingsResource } from "./useSettingsResource";

/** 応答の provider 一覧から表示名を引く。未知でも id を出して操作を止めない */
function providerName(response: WebSearchSettingsResponse, provider: WebSearchProviderId): string {
  return response.providers.find((entry) => entry.id === provider)?.name ?? provider;
}

/**
 * 設定 → Web 検索の state と操作。GET はこの画面を開いたときだけ取り、
 * 変更系の応答は GET と同じ形なので、注記を付けてそのまま次の状態にできる。
 * 保存は「その場で効く」前提なので、失敗したら状態を変えずに理由だけを出す。
 */
export function useWebSearchSettings() {
  const { settings, note, saving, reloading, reload, runMutation, setNote } = useSettingsResource<
    WebSearchSettingsResponse,
    WebSearchSavingAction
  >({
    defaultNote: WEB_SEARCH_SETTINGS_NOTE,
    loadErrorLabel: "Web 検索の設定を読み込めませんでした。",
    load: getWebSearchSettings,
  });

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
    [runMutation, setNote],
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
