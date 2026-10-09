import { useCallback, useEffect, useState } from "react";
import { isNotStoredError } from "../api";
import { messageFor, mutationErrorNote, successNoteText, type SettingsSuccessNote } from "../lib/settingsResource";
import { createLoadingTracker, createRequestGate } from "./requestGate";

export interface SettingsNote {
  text: string;
  error: boolean;
}

export interface SettingsResourceOptions<TResponse> {
  /** 読み込み前と、読み込み / 変更の成功後に出す注記 */
  defaultNote: string;
  /** GET の失敗の前置き。理由は hook が続けて足す */
  loadErrorLabel: string;
  load: () => Promise<TResponse>;
  /** 応答の適用直後に、表示中の別 state を server の現在値へ揃える追随 */
  onApply?: (response: TResponse) => void;
}

/**
 * 設定資源（GET で読む設定と変更系 API）の共通骨格。settings / note / saving / reloading の 4 state と、
 * 「進行中の読み込みの応答を、いま適用した応答で上書きさせない」ガードを 1 箇所に置く。
 * `options` の関数は deps に入るため、呼び出し側は module 定数か `useCallback` で渡す
 * （render ごとに ident が変わると reload が毎 render 走る）。
 */
export function useSettingsResource<TResponse, TAction extends string>(options: SettingsResourceOptions<TResponse>) {
  const { defaultNote, load, loadErrorLabel, onApply } = options;
  const [settings, setSettings] = useState<TResponse | null>(null);
  const [note, setNote] = useState<SettingsNote>({ text: defaultNote, error: false });
  const [saving, setSaving] = useState<TAction | null>(null);
  const [reloading, setReloading] = useState(false);
  const [beginLoad] = useState(createRequestGate);
  // 破棄された取得でも進行中を解除するため、適用の可否とは別に追う
  const [reloadTracker] = useState(() => createLoadingTracker(setReloading));

  const reload = useCallback(async (): Promise<void> => {
    const canApply = beginLoad();
    const finishReload = reloadTracker.begin();
    try {
      const next = await load();
      if (!canApply()) return;
      setSettings(next);
      onApply?.(next);
      setNote({ text: defaultNote, error: false });
    } catch (error) {
      if (canApply()) {
        setNote({ text: `${loadErrorLabel}${messageFor(error)}`, error: true });
      }
    } finally {
      finishReload();
    }
  }, [beginLoad, defaultNote, load, loadErrorLabel, onApply, reloadTracker]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const runMutation = useCallback(
    async (
      action: TAction,
      successNote: SettingsSuccessNote<TResponse>,
      run: () => Promise<TResponse>,
    ): Promise<boolean> => {
      setSaving(action);
      try {
        const response = await run();
        // 進行中の読み込みの応答で、いま適用した応答を上書きさせない
        beginLoad();
        setSettings(response);
        onApply?.(response);
        setNote({ text: successNoteText(successNote, response), error: false });
        return true;
      } catch (error) {
        setNote({ text: mutationErrorNote(error, isNotStoredError(error)), error: true });
        return false;
      } finally {
        setSaving(null);
      }
    },
    [beginLoad, onApply],
  );

  return {
    settings,
    note,
    saving,
    reloading,
    reload,
    runMutation,
    // 骨格に乗らない操作（応答の一部だけを差し替えるカタログ更新など）が同じ state とガードを使うための口
    setSettings,
    setNote,
    setSaving,
    invalidatePendingLoads: beginLoad,
  };
}
