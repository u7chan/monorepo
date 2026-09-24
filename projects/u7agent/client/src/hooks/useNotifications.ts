import { useCallback, useEffect, useRef, useState } from "react";
import { getNotifications, testNotification, updateNotifications } from "../api";
import { draftBody, draftFromSettings, draftIsDirty, syncDraft, type NotificationDraft } from "../lib/notifications";
import { MEMORY_NOTE } from "../lib/settingsNotes";
import type { NotificationResult, NotificationsResponse } from "../types";
import { createRequestGate } from "./requestGate";

/** 一覧 (4 秒) と同じ間隔。バックグラウンドのラン完了で直近結果が変わっても、⚠ をリロードなしで反映する */
const NOTIFICATIONS_POLL_MS = 4_000;

const alwaysCurrent = () => true;

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 通知設定の state と操作。設定ページを開いていなくてもナビの ⚠ が要るため、facade (useU7Agent) が
 * 起動時に読み込み、下書きもここが持つ (保存 / テストの結果を 1 箇所でノートへまとめるため)。
 */
export function useNotifications() {
  const [settings, setSettings] = useState<NotificationsResponse | null>(null);
  const [draft, setDraftState] = useState<NotificationDraft>(() => draftFromSettings(null));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean }>({ text: MEMORY_NOTE, error: false });
  // 保存の応答が返るまでに下書きを触られたら、その編集を保存完了の値で上書きしない
  const draftRevisionRef = useRef(0);
  /** 直前の保存値。取得値へ下書きを追従させるときの「未編集」判定に使う */
  const settingsRef = useRef<NotificationsResponse | null>(null);
  const [beginLoad] = useState(createRequestGate);

  const setDraft = useCallback((patch: Partial<NotificationDraft>) => {
    draftRevisionRef.current += 1;
    setDraftState((prev) => ({ ...prev, ...patch }));
  }, []);

  /**
   * 設定の適用。resetDraft は下書きを保存値から作り直す (明示の再読み込みと、保存の完了)。
   * それ以外は未編集のフィールドだけ追従させる (他タブの保存を古い下書きで巻き戻さないため)。
   */
  const applySettings = useCallback((next: NotificationsResponse, resetDraft: boolean) => {
    const previous = settingsRef.current;
    settingsRef.current = next;
    setSettings(next);
    if (resetDraft || !previous) {
      draftRevisionRef.current += 1;
      setDraftState(draftFromSettings(next));
      return;
    }
    setDraftState((draft) => syncDraft(draft, previous, next));
  }, []);

  /** 設定だけを取り直す。下書きは未編集のフィールドだけ追従させる (定期取得とテスト後の更新) */
  const refresh = useCallback(
    async (isCurrent = alwaysCurrent): Promise<void> => {
      const canApply = beginLoad(isCurrent);
      try {
        const next = await getNotifications();
        if (!canApply()) return;
        applySettings(next, false);
      } catch {
        // 一時的に届かないときは前回の値を保つ (⚠ の判定を勝手に消さない)
      }
    },
    [applySettings, beginLoad],
  );

  /** 再読み込み。下書きは保存値から作り直す (URL の入力途中でも捨てる) */
  const reload = useCallback(async (): Promise<void> => {
    const canApply = beginLoad();
    try {
      const next = await getNotifications();
      if (!canApply()) return;
      applySettings(next, true);
    } catch (error) {
      if (canApply()) setNote({ text: `通知の設定を読み込めませんでした。${messageFor(error)}`, error: true });
    }
  }, [applySettings, beginLoad]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setInterval(() => void refresh(() => !cancelled), NOTIFICATIONS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const save = useCallback(async (): Promise<boolean> => {
    const revision = draftRevisionRef.current;
    setSaving(true);
    try {
      const next = await updateNotifications(draftBody(draft));
      // 進行中 / 保存中に届く定期取得の古い応答を捨てる (保存後の値で上書きされないように)
      beginLoad();
      // 保存中に触られていなければ、下書きを保存済みの値へ揃える (URL の入力欄は閉じる)。
      // 触られていたら未編集のフィールドだけ追従させる (その編集を消さない)
      applySettings(next, draftRevisionRef.current === revision);
      setNote({ text: "通知の設定を保存しました。", error: false });
      return true;
    } catch (error) {
      setNote({ text: `保存できませんでした。${messageFor(error)}`, error: true });
      return false;
    } finally {
      setSaving(false);
    }
  }, [applySettings, beginLoad, draft]);

  /** 保存済み設定で 1 通送る。saveFirst は「保存してテスト」(URL の未保存変更があるとき) */
  const test = useCallback(
    async (saveFirst = false): Promise<NotificationResult | null> => {
      setTesting(true);
      try {
        if (saveFirst && !(await save())) return null;
        const result = await testNotification();
        // 直近結果は通常通知と共通の 1 件。応答には載らないため GET で取り直す (ナビの ⚠ もここで更新する)
        await refresh();
        setNote(
          result.ok
            ? { text: "テスト通知を送信しました。Discord のチャンネルを確認してください。", error: false }
            : { text: "テスト通知は送信できませんでした。結果を確認してください。", error: true },
        );
        return result;
      } catch (error) {
        setNote({ text: `テスト送信に失敗しました。${messageFor(error)}`, error: true });
        return null;
      } finally {
        setTesting(false);
      }
    },
    [refresh, save],
  );

  /** 下書きの破棄。保存済みの値へ戻す (URL は write-only なので空に戻る) */
  const discard = useCallback(() => {
    draftRevisionRef.current += 1;
    setDraftState(draftFromSettings(settingsRef.current));
    setNote({ text: MEMORY_NOTE, error: false });
  }, []);

  return {
    settings,
    draft,
    setDraft,
    dirty: draftIsDirty(draft, settings),
    saving,
    testing,
    note,
    reload,
    save,
    test,
    discard,
  };
}

export type Notifications = ReturnType<typeof useNotifications>;
