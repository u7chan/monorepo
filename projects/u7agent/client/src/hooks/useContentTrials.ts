import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelContentTrial,
  deleteAllContentTrials,
  deleteContentTrial,
  listContentTrials,
  startContentTrial,
} from "../api";
import { hasRunningTrial, newlyFinishedKinds, trialKindSubsection } from "../lib/contentTrials";
import { messageFor } from "../lib/settingsResource";
import type { ContentSubsection } from "../lib/settingsNav";
import type { ContentTrial, CreateContentTrialBody } from "../types";

/** 実行中に一覧を取り直す間隔。画面を離れていても結果を拾えるよう、開いている間だけ回す */
const TRIAL_POLL_INTERVAL_MS = 2_000;

export type ContentTrialsNote = { text: string; error: boolean };

/**
 * 設定 → コンテンツ生成の試行ジョブの state。一覧は画面が開いている間だけ取り、
 * 実行中の試行がある間はポーリングする。**応答は要求の seq で捨て、unmount 後は適用しない**
 * （遅い応答で表示を戻さない）。
 */
export function useContentTrials({ activeSubsection }: { activeSubsection: ContentSubsection }) {
  const [trials, setTrials] = useState<ContentTrial[] | null>(null);
  const [keyEpoch, setKeyEpoch] = useState(0);
  const [note, setNote] = useState<ContentTrialsNote | null>(null);
  const [busy, setBusy] = useState(false);
  /** 別のタブで終端した試行の種別。そのタブを開いたら消す */
  const [newResults, setNewResults] = useState<readonly ContentSubsection[]>([]);
  const seq = useRef(0);
  const alive = useRef(true);
  const previous = useRef<ContentTrial[] | null>(null);
  const active = useRef<ContentSubsection>(activeSubsection);
  active.current = activeSubsection;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const apply = useCallback((next: ContentTrial[], nextKeyEpoch: number) => {
    const finished = newlyFinishedKinds({
      previous: previous.current,
      next,
      activeSubsection: active.current,
    });
    previous.current = next;
    setTrials(next);
    setKeyEpoch(nextKeyEpoch);
    if (finished.length > 0) {
      setNewResults((current) => [...new Set([...current, ...finished.map(trialKindSubsection)])]);
    }
  }, []);

  const load = useCallback(async (): Promise<boolean> => {
    const request = ++seq.current;
    try {
      const response = await listContentTrials();
      // 後から始めた要求がある / unmount 済みなら、この応答では表示を変えない
      if (!alive.current || request !== seq.current) return false;
      apply(response.items, response.keyEpoch);
      return true;
    } catch (error) {
      if (alive.current && request === seq.current) {
        setNote({ text: `試行の履歴を取得できませんでした。${messageFor(error)}`, error: true });
      }
      return false;
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  // 実行中の試行がある間だけ取り直す。1 回の取得が終わってから次を予約し、GET を積み上げない
  const running = trials !== null && hasRunningTrial(trials);
  useEffect(() => {
    if (!running) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = () => {
      timer = setTimeout(() => {
        void load().finally(() => {
          if (!stopped) tick();
        });
      }, TRIAL_POLL_INTERVAL_MS);
    };
    tick();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [running, load]);

  // 開いたタブの新着は消す（印はページ再訪時に残さない）
  useEffect(() => {
    setNewResults((current) =>
      current.includes(activeSubsection) ? current.filter((item) => item !== activeSubsection) : current,
    );
  }, [activeSubsection]);

  const start = useCallback(async (input: CreateContentTrialBody): Promise<boolean> => {
    setBusy(true);
    try {
      const response = await startContentTrial(input);
      if (!alive.current) return true;
      // 開始直後の状態を反映し、その後の完了はポーリングで拾う
      setTrials((current) => [response.trial, ...(current ?? [])]);
      previous.current = [response.trial, ...(previous.current ?? [])];
      setNote({ text: "試行を開始しました。画面を離れても続きます。", error: false });
      return true;
    } catch (error) {
      if (alive.current) setNote({ text: `試行を開始できませんでした。${messageFor(error)}`, error: true });
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  const cancel = useCallback(
    async (id: string): Promise<boolean> => {
      setBusy(true);
      try {
        const response = await cancelContentTrial(id);
        if (!alive.current) return true;
        setTrials((current) =>
          (current ?? []).map((trial) => (trial.id === response.trial.id ? response.trial : trial)),
        );
        setNote({ text: "試行を中断しました。", error: false });
        return true;
      } catch (error) {
        if (alive.current) setNote({ text: `試行を中断できませんでした。${messageFor(error)}`, error: true });
        // すでに終端していた可能性があるので、表示は権威ある一覧へ揃える
        void load();
        return false;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [load],
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      setBusy(true);
      try {
        await deleteContentTrial(id);
        if (!alive.current) return true;
        setTrials((current) => (current ?? []).filter((trial) => trial.id !== id));
        setNote({ text: "試行の履歴を削除しました。", error: false });
        return true;
      } catch (error) {
        if (alive.current) setNote({ text: `試行の履歴を削除できませんでした。${messageFor(error)}`, error: true });
        void load();
        return false;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [load],
  );

  const removeAll = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    try {
      const response = await deleteAllContentTrials();
      if (!alive.current) return true;
      await load();
      if (alive.current) {
        setNote({
          text:
            response.removed === 0
              ? "削除できる履歴がありません（実行中の試行は残ります）。"
              : `試行の履歴を ${response.removed} 件削除しました（実行中の試行は残ります）。`,
          error: false,
        });
      }
      return true;
    } catch (error) {
      if (alive.current) setNote({ text: `試行の履歴を削除できませんでした。${messageFor(error)}`, error: true });
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [load]);

  return {
    /** 一覧を取得できていない間は null */
    trials,
    keyEpoch,
    note,
    busy,
    newResults,
    running,
    reload: load,
    start,
    cancel,
    remove,
    removeAll,
  };
}

export type ContentTrials = ReturnType<typeof useContentTrials>;
