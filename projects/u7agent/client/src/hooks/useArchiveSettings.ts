import { useCallback, useEffect, useState } from "react";
import { getArchiveSettings, resetArchiveSettings, updateArchiveSettings } from "../api";
import {
  addExcludeName,
  archiveSettingsDirty,
  draftFromSettings,
  removeExcludeName,
  validateExcludeNames,
  type ArchiveSettingsDraft,
} from "../lib/archiveSettings";
import { MEMORY_NOTE } from "../lib/settingsNotes";
import type { ArchiveSettingsResponse } from "../types";
import { createRequestGate } from "./requestGate";

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * アーカイブの除外名の state と操作。行の出し分け（ツリーのダウンロードボタン）が保存の直後に追随する必要があるため、
 * 設定ページを開いていなくても facade（useU7Agent）が起動時に読み込み、画面とツリーで同じ実効値を見る。
 */
export function useArchiveSettings() {
  const [settings, setSettings] = useState<ArchiveSettingsResponse | null>(null);
  const [draft, setDraftState] = useState<ArchiveSettingsDraft>(() => draftFromSettings(null));
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean }>({ text: MEMORY_NOTE, error: false });
  const [beginLoad] = useState(createRequestGate);

  /** 保存 / リセット / 再読み込みの応答を下書きごと適用する（編集は常に保存値から始め直す） */
  const applySettings = useCallback((next: ArchiveSettingsResponse) => {
    setSettings(next);
    setDraftState(draftFromSettings(next));
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    const canApply = beginLoad();
    try {
      const next = await getArchiveSettings();
      if (!canApply()) return;
      applySettings(next);
    } catch (error) {
      if (canApply()) {
        setNote({ text: `アーカイブの除外名を読み込めませんでした。${messageFor(error)}`, error: true });
      }
    }
  }, [applySettings, beginLoad]);

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
    const reason = validateExcludeNames(draft, settings.maxNames, settings.maxNameLength);
    if (reason) {
      setNote({ text: reason, error: true });
      return false;
    }
    setSaving(true);
    try {
      const next = await updateArchiveSettings(draft.excludeNames);
      // 保存中に始まった読み込みの応答で上書きされないよう、適用の前に世代を進める
      beginLoad();
      applySettings(next);
      setNote({ text: "アーカイブの除外名を保存しました。", error: false });
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
      const next = await resetArchiveSettings();
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
    note,
    add,
    remove,
    reload,
    save,
    reset,
    discard,
  };
}

export type ArchiveSettings = ReturnType<typeof useArchiveSettings>;
