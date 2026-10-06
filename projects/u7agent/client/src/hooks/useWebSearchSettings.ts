import { useCallback, useEffect, useState } from "react";
import { ApiError, getWebSearchSettings, putWebSearchSettings } from "../api";
import { WEB_SEARCH_SETTINGS_NOTE, webSearchSavedNote } from "../lib/webSearchSettings";
import type { WebSearchSettingsResponse } from "../types";
import { createLoadingTracker, createRequestGate } from "./requestGate";

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 設定 → モデル（Web 検索タブ）の state と操作。GET はこの画面を開いたときだけ取り、
 * PUT の応答は GET と同じ形なので、注記を付けてそのまま次の状態にできる。
 * 保存は「その場で効く」前提なので、失敗したら状態を変えずに 503 の理由だけを出す。
 */
export function useWebSearchSettings() {
  const [settings, setSettings] = useState<WebSearchSettingsResponse | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean }>({
    text: WEB_SEARCH_SETTINGS_NOTE,
    error: false,
  });
  const [saving, setSaving] = useState(false);
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

  const setEnabled = useCallback(
    async (enabled: boolean): Promise<boolean> => {
      setSaving(true);
      try {
        const response = await putWebSearchSettings(enabled);
        // 進行中の読み込みの応答で、いま適用した応答を上書きさせない
        beginLoad();
        setSettings(response);
        setNote({ text: webSearchSavedNote(response.enabled), error: false });
        return true;
      } catch (error) {
        // 何も保存されなかった (503 not_stored / 400) ことを文言で区別する
        const prefix = error instanceof ApiError && error.state === "not_stored" ? "変更は保存されていません。" : "";
        setNote({ text: `${prefix}${messageFor(error)}`, error: true });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [beginLoad],
  );

  return { settings, note, saving, reloading, reload, setEnabled };
}

export type WebSearchSettings = ReturnType<typeof useWebSearchSettings>;
