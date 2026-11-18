import { useCallback, useState } from "react";
import { getSharedContentExclusions, resetSharedContentExclusions, updateSharedContentExclusions } from "../api";
import { messageFor } from "../lib/errors";
import {
  addExcludeName,
  archiveSettingsDirty,
  draftFromSettings,
  excludeNamesNote,
  removeExcludeName,
  type ArchiveSettingsDraft,
} from "../lib/archiveSettings";
import { validateSharedContentExcludeNames } from "../lib/sharedContentExclusions";
import { MEMORY_NOTE } from "../lib/settingsNotes";
import type { SharedContentExclusionsResponse } from "../types";
import { useSettingsResource } from "./useSettingsResource";

/** 変更系の action 名。骨格は TAction | null を持つが、この画面は「保存中か」しか見ないので外へは boolean を出す */
type SharedContentSavingAction = "save" | "reset";

/**
 * 設定 → 共有「公開の除外」の state と操作。一覧の下書き・追加・削除はアーカイブの設定と同じ純関数を使い、
 * 保存 / 既定に戻す / 再読み込みは共有専用の API を叩く（ダウンロードの除外とは別の行）。
 * 移行時の差は骨格側を正とした: 再読み込み成功で note は既定へ戻る（失敗の注記が成功後も残らない）。
 * `saving` だけは画面の `disabled` と既存テストが boolean 前提なので boolean で返す。
 */
export function useSharedContentExclusions() {
  const [draft, setDraft] = useState<ArchiveSettingsDraft>(() => draftFromSettings(null));

  /** 保存 / リセット / 再読み込みの応答を下書きごと適用する（編集は常に保存値から始め直す） */
  const applyDraft = useCallback((next: SharedContentExclusionsResponse) => {
    setDraft(draftFromSettings(next));
  }, []);

  const { settings, note, saving, reloading, reload, setSettings, setNote, setSaving, invalidatePendingLoads } =
    useSettingsResource<SharedContentExclusionsResponse, SharedContentSavingAction>({
      defaultNote: MEMORY_NOTE,
      loadErrorLabel: "公開の除外名を読み込めませんでした。",
      load: getSharedContentExclusions,
      onApply: applyDraft,
    });

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
      setDraft(next);
      // 直前の保存エラー（不正名など）は編集で解消しうるが、保存済みの案内に戻すと反映済みと読める
      setNote(excludeNamesNote(next, settings));
      return true;
    },
    [draft, setNote, settings],
  );

  const remove = useCallback(
    (name: string): void => {
      const next = removeExcludeName(draft, name);
      setDraft(next);
      setNote(excludeNamesNote(next, settings));
    },
    [draft, setNote, settings],
  );

  const discard = useCallback((): void => {
    setDraft(draftFromSettings(settings));
    setNote({ text: MEMORY_NOTE, error: false });
  }, [setNote, settings]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!settings) return false;
    // 不正名は保存せず、理由をそのまま画面へ出す（サーバーも同じ規則で 400 を返す）
    const reason = validateSharedContentExcludeNames(draft, settings.maxNames, settings.maxNameLength);
    if (reason) {
      setNote({ text: reason, error: true });
      return false;
    }
    // 失敗の注記を「保存できませんでした。」で組み続けるため、runMutation（mutationErrorNote 固定）は通さない
    setSaving("save");
    try {
      const next = await updateSharedContentExclusions(draft.excludeNames);
      // 保存中に始まった読み込みの応答で上書きされないよう、適用の前に世代を進める
      invalidatePendingLoads();
      setSettings(next);
      applyDraft(next);
      setNote({ text: "公開の除外名を保存しました。", error: false });
      return true;
    } catch (error) {
      setNote({ text: `保存できませんでした。${messageFor(error)}`, error: true });
      return false;
    } finally {
      setSaving(null);
    }
  }, [applyDraft, draft, invalidatePendingLoads, setNote, setSaving, setSettings, settings]);

  const reset = useCallback(async (): Promise<boolean> => {
    setSaving("reset");
    try {
      const next = await resetSharedContentExclusions();
      invalidatePendingLoads();
      setSettings(next);
      applyDraft(next);
      setNote({ text: "既定の一覧に戻しました。", error: false });
      return true;
    } catch (error) {
      setNote({ text: `既定に戻せませんでした。${messageFor(error)}`, error: true });
      return false;
    } finally {
      setSaving(null);
    }
  }, [applyDraft, invalidatePendingLoads, setNote, setSaving, setSettings]);

  return {
    settings,
    draft,
    dirty: archiveSettingsDirty(draft, settings),
    // 骨格の saving は action 名を持つが、画面（disabled）と既存テストは「保存中か」だけを使う
    saving: saving !== null,
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
