import { useCallback, useState } from "react";
import {
  deleteWebSearchApiKey,
  getWebSearchSettings,
  postWebSearchTest,
  putWebSearchApiKey,
  putWebSearchProvider,
  putWebSearchSettings,
} from "../api";
import {
  createSettingsGeneration,
  WEB_SEARCH_SETTINGS_NOTE,
  webSearchKeyDeletedNote,
  webSearchKeySavedNote,
  webSearchProviderSavedNote,
  runWebSearchTest,
  webSearchSavedNote,
  type WebSearchSavingAction,
  type WebSearchTestOutcome,
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
  const [testing, setTesting] = useState(false);
  const [testOutcome, setTestOutcome] = useState<WebSearchTestOutcome | null>(null);
  const [settingsGeneration] = useState(createSettingsGeneration);
  // 設定が変わったら (保存 / 再読み込み)、前の設定で取った結果と、いま進んでいる検索を無効にする
  const clearTestOutcome = useCallback(() => {
    settingsGeneration.invalidate();
    setTestOutcome(null);
  }, [settingsGeneration]);
  const { settings, note, saving, reloading, reload, runMutation, setNote } = useSettingsResource<
    WebSearchSettingsResponse,
    WebSearchSavingAction
  >({
    defaultNote: WEB_SEARCH_SETTINGS_NOTE,
    loadErrorLabel: "Web 検索の設定を読み込めませんでした。",
    load: getWebSearchSettings,
    onApply: clearTestOutcome,
  });

  /**
   * テスト検索。保存済みの設定で 1 回だけ検索し、応答を送ったクエリと組で残す。
   * 通信 / 503 の失敗も同じ形に畳み、描画側の分岐を成功 / 失敗の 1 つに保つ。
   */
  const test = useCallback(
    async (query: string): Promise<void> => {
      setTesting(true);
      try {
        // 設定が変わったときの採否は runWebSearchTest が決める (世代を跨いだ応答は null)
        setTestOutcome(await runWebSearchTest(query, { generation: settingsGeneration, request: postWebSearchTest }));
      } finally {
        setTesting(false);
      }
    },
    [settingsGeneration],
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

  return {
    settings,
    note,
    saving,
    reloading,
    reload,
    setEnabled,
    setProvider,
    saveKey,
    removeKey,
    testing,
    testOutcome,
    test,
  };
}

export type WebSearchSettings = ReturnType<typeof useWebSearchSettings>;
