import { useCallback, useEffect, useState } from "react";
import { getSharedContentExclusions, resetSharedContentExclusions, updateSharedContentExclusions } from "../api";
import {
  addExcludeName,
  archiveSettingsDirty,
  draftFromSettings,
  removeExcludeName,
  type ArchiveSettingsDraft,
} from "../lib/archiveSettings";
import { validateSharedContentExcludeNames } from "../lib/sharedContentExclusions";
import { MEMORY_NOTE } from "../lib/settingsNotes";
import type { SharedContentExclusionsResponse } from "../types";
import { createLoadingTracker, createRequestGate } from "./requestGate";

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 設定 → 共有「公開の除外」の state と操作。一覧の下書き・追加・削除はアーカイブの設定と同じ純関数を使い、
 * 保存 / 既定に戻す / 再読み込みは共有専用の API を叩く（ダウンロードの除外とは別の行）。
 */
export function useSharedContentExclusions() {
  const [settings, setSettings] = useState<SharedContentExclusionsResponse | null>(null);
  const [draft, setDraftState] = useState<ArchiveSettingsDraft>(() => draftFromSettings(null));
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean }>({ text: MEMORY_NOTE, error: false });
  const [reloading, setReloading] = useState(false);
  const [beginLoad] = useState(createRequestGate);
  // 破棄された取得でも進行中を解除するため、適用の可否とは別に追う
  const [reloadTracker] = useState(() => createLoadingTracker(setReloading));

  /** 保存 / リセット / 再読み込みの応答を下書きごと適用する（編集は常に保存値から始め直す） */
  const applySettings = useCallback((next: SharedContentExclusionsResponse) => {
    setSettings(next);
    setDraftState(draftFromSettings(next));
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    const canApply = beginLoad();
    const finishReload = reloadTracker.begin();
    try {
      const next = await getSharedContentExclusions();
      if (!canApply()) return;
      applySettings(next);
    } catch (error) {
      if (canApply()) {
        setNote({ text: `公開の除外名を読み込めませんでした。${messageFor(error)}`, error: true });
      }
    } finally {
      finishReload();
    }
  }, [applySettings, beginLoad, reloadTracker]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 1 件追加する。空と重複は何もせず、上限だけは理由を出す（名前の妥当性は保存時に見る） */
  const add = useCallback(
    (raw: string): boolean => {
      if (!settings) return false;
      const name = raw.trim();
      if (!name || draft.excludeNames.includes(name)) return false;
      const next = addExcludeName(draft, name, settings.maxNames);
      if (next === draft) {
        setNote({ text: `除外名は ${settings.maxNames} 件までです`, error: true });
        return false;
      }
      setDraftState(next);
      // 直前の保存エラー（不正名など）は編集で解消しうるので、操作のたびに注記を戻す
      setNote({ text: MEMORY_NOTE, error: false });
      return true;
    },
    [draft, settings],
  );

  const remove = useCallback((name: string): void => {
    setDraftState((prev) => removeExcludeName(prev, name));
    setNote({ text: MEMORY_NOTE, error: false });
  }, []);

  const discard = useCallback((): void => {
    setDraftState(draftFromSettings(settings));
    setNote({ text: MEMORY_NOTE, error: false });
  }, [settings]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!settings) return false;
    // 不正名は保存せず、理由をそのまま画面へ出す（サーバーも同じ規則で 400 を返す）
    const reason = validateSharedContentExcludeNames(draft, settings.maxNames, settings.maxNameLength);
    if (reason) {
      setNote({ text: reason, error: true });
      return false;
    }
    setSaving(true);
    try {
      const next = await updateSharedContentExclusions(draft.excludeNames);
      // 保存中に始まった読み込みの応答で上書きされないよう、適用の前に世代を進める
      beginLoad();
      applySettings(next);
      setNote({ text: "公開の除外名を保存しました。", error: false });
      return true;
    } catch (error) {
      setNote({ text: `保存できませんでした。${messageFor(error)}`, error: true });
      return false;
    } finally {
      setSaving(false);
    }
  }, [applySettings, beginLoad, draft, settings]);

  const reset = useCallback(async (): Promise<boolean> => {
    setSaving(true);
    try {
      const next = await resetSharedContentExclusions();
      beginLoad();
      applySettings(next);
      setNote({ text: "既定の一覧に戻しました。", error: false });
      return true;
    } catch (error) {
      setNote({ text: `既定に戻せませんでした。${messageFor(error)}`, error: true });
      return false;
    } finally {
      setSaving(false);
    }
  }, [applySettings, beginLoad]);

  return {
    settings,
    draft,
    dirty: archiveSettingsDirty(draft, settings),
    saving,
    reloading,
    note,
    add,
    remove,
    reload,
    save,
    reset,
    discard,
  };
}

export type SharedContentExclusionsSettings = ReturnType<typeof useSharedContentExclusions>;
