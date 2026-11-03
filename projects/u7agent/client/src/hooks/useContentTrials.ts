import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelContentTrial,
  deleteAllContentTrials,
  deleteContentTrial,
  listContentTrials,
  startContentTrial,
} from "../api";
import {
  hasRunningTrial,
  newlyFinishedKinds,
  removeTrialThenRefresh,
  trialKindLabel,
  trialKindSubsection,
  trialRemoveAllNote,
} from "../lib/contentTrials";
import { messageFor } from "../lib/settingsResource";
import type { ContentSubsection } from "../lib/settingsNav";
import type { ContentTrial, ContentTrialArtifactUsageValue, CreateContentTrialBody } from "../types";

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
  /** 保存容量（保存済みの成功だけを DB のバイト数で合計したもの） */
  const [artifactUsage, setArtifactUsage] = useState<ContentTrialArtifactUsageValue>({ count: 0, bytes: 0 });
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

  const apply = useCallback((next: ContentTrial[], nextKeyEpoch: number, usage: ContentTrialArtifactUsageValue) => {
    const finished = newlyFinishedKinds({
      previous: previous.current,
      next,
      activeSubsection: active.current,
    });
    previous.current = next;
    setTrials(next);
    setKeyEpoch(nextKeyEpoch);
    setArtifactUsage(usage);
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
      apply(response.items, response.keyEpoch, response.artifactUsage);
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
      // 再利用は「同じ入力の保存済み結果」を返す。新しい成功として積まず、既存の行を差し替える
      const trial = response.trial;
      setTrials((current) => {
        const list = current ?? [];
        return list.some((item) => item.id === trial.id)
          ? list.map((item) => (item.id === trial.id ? trial : item))
          : [trial, ...list];
      });
      setNote({
        text: response.reused
          ? "同じ入力の保存済みの結果を表示しています（課金していません）。"
          : "試行を開始しました。画面を離れても続きます。",
        error: false,
      });
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
        // 行だけをローカルで除くと保存容量（一覧の応答にしか載らない）が古いまま残るため、必ず取り直す
        const refreshed = await removeTrialThenRefresh({ id, remove: deleteContentTrial, reload: load });
        if (!alive.current) return true;
        setNote(
          refreshed
            ? { text: "試行の履歴を削除しました。", error: false }
            : {
                text: "試行の履歴は削除しましたが、一覧を取り直せませんでした。再読み込みしてください。",
                error: true,
              },
        );
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

  /**
   * 種別ごとの全削除。面は自分の種別の履歴しか見せないため、種別を渡さずに消すと
   * もう一方のタブの履歴と保存容量まで消える（API の `?kind=` で絞る）。
   */
  const removeAll = useCallback(
    async (kind: ContentTrial["kind"]): Promise<boolean> => {
      setBusy(true);
      try {
        const response = await deleteAllContentTrials(kind);
        if (!alive.current) return true;
        await load();
        if (alive.current) {
          setNote({ text: trialRemoveAllNote(kind, response.removed), error: false });
        }
        return true;
      } catch (error) {
        if (alive.current) {
          setNote({
            text: `${trialKindLabel(kind)}の試行の履歴を削除できませんでした。${messageFor(error)}`,
            error: true,
          });
        }
        return false;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [load],
  );

  return {
    /** 一覧を取得できていない間は null */
    trials,
    keyEpoch,
    /** 保存容量（`succeeded` + 保存済みの件数とバイト数） */
    artifactUsage,
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
