import { useCallback, useState } from "react";
import {
  addExcludeName,
  archiveSettingsDirty,
  draftFromSettings,
  excludeNamesNote,
  removeExcludeName,
  type ArchiveSettingsDraft,
} from "../lib/archiveSettings";
import { messageFor } from "../lib/errors";
import { MEMORY_NOTE } from "../lib/settingsNotes";
import type { ArchiveSettingsResponse } from "../types";
import { useSettingsResource, type SettingsNote } from "./useSettingsResource";

/** 変更系の action 名。骨格は TAction | null を持つが、この画面は「保存中か」しか見ないので外へは boolean を出す */
type ExcludeNamesSavingAction = "save" | "reset";

/**
 * ダウンロード（ZIP）の除外名と公開（Cloudflare）の除外名で違うのは、API・検証・文言だけ。
 * 一覧そのものは別の行・別の既定を持つので、共有するのは編集と保存の手順に限る。
 */
export interface ExcludeNamesSettingsOptions<TResponse extends ArchiveSettingsResponse> {
  /** 読み込みに失敗したときの前置き。理由は hook が続けて足す */
  loadErrorLabel: string;
  load: () => Promise<TResponse>;
  save: (excludeNames: string[]) => Promise<TResponse>;
  reset: () => Promise<TResponse>;
  /** 保存に成功したときの注記 */
  savedNote: string;
  /** 保存前の検証。1 セグメント名の規則と件数上限に、その設定だけの規則を足す */
  validate: (draft: ArchiveSettingsDraft, maxNames: number, maxNameLength: number) => string | undefined;
}

export interface ExcludeNamesSettings<TResponse extends ArchiveSettingsResponse> {
  settings: TResponse | null;
  draft: ArchiveSettingsDraft;
  dirty: boolean;
  saving: boolean;
  reloading: boolean;
  note: SettingsNote;
  add: (raw: string) => boolean;
  remove: (name: string) => void;
  reload: () => Promise<void>;
  save: () => Promise<boolean>;
  reset: () => Promise<boolean>;
  discard: () => void;
}

/** 操作帯（再読み込み・破棄・既定に戻す・保存）が読む口。2 つの設定で同じ帯を使う */
export type ExcludeNamesToolbarSettings = Pick<
  ExcludeNamesSettings<ArchiveSettingsResponse>,
  "settings" | "dirty" | "saving" | "reloading" | "reload" | "save" | "reset" | "discard"
>;

/**
 * 除外名の一覧を持つ設定の state と操作。下書きの追加・削除・破棄と、保存 / 既定に戻す / 再読み込みの
 * 手順をここに置く。`options` は module 定数か `useCallback` で渡す（骨格の deps に入る）。
 */
export function useExcludeNamesSettings<TResponse extends ArchiveSettingsResponse>(
  options: ExcludeNamesSettingsOptions<TResponse>,
): ExcludeNamesSettings<TResponse> {
  const { load, loadErrorLabel, reset: resetRequest, save: saveRequest, savedNote, validate } = options;
  const [draft, setDraft] = useState<ArchiveSettingsDraft>(() => draftFromSettings(null));

  /** 保存 / リセット / 再読み込みの応答を下書きごと適用する（編集は常に保存値から始め直す） */
  const applyDraft = useCallback((next: TResponse) => {
    setDraft(draftFromSettings(next));
  }, []);

  const { settings, note, saving, reloading, reload, setSettings, setNote, setSaving, invalidatePendingLoads } =
    useSettingsResource<TResponse, ExcludeNamesSavingAction>({
      defaultNote: MEMORY_NOTE,
      loadErrorLabel,
      load,
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
    const reason = validate(draft, settings.maxNames, settings.maxNameLength);
    if (reason) {
      setNote({ text: reason, error: true });
      return false;
    }
    // 失敗の注記を「保存できませんでした。」で組み続けるため、runMutation（mutationErrorNote 固定）は通さない
    setSaving("save");
    try {
      const next = await saveRequest(draft.excludeNames);
      // 保存中に始まった読み込みの応答で上書きされないよう、適用の前に世代を進める
      invalidatePendingLoads();
      setSettings(next);
      applyDraft(next);
      setNote({ text: savedNote, error: false });
      return true;
    } catch (error) {
      setNote({ text: `保存できませんでした。${messageFor(error)}`, error: true });
      return false;
    } finally {
      setSaving(null);
    }
  }, [
    applyDraft,
    draft,
    invalidatePendingLoads,
    savedNote,
    saveRequest,
    setNote,
    setSaving,
    setSettings,
    settings,
    validate,
  ]);

  const reset = useCallback(async (): Promise<boolean> => {
    setSaving("reset");
    try {
      const next = await resetRequest();
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
  }, [applyDraft, invalidatePendingLoads, resetRequest, setNote, setSaving, setSettings]);

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
