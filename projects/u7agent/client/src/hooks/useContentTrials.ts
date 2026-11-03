import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelContentTrial,
  deleteAllContentTrials,
  deleteContentTrial,
  listContentTrials,
  startContentTrial,
} from "../api";
import { createContentTrialsController, INITIAL_CONTENT_TRIALS_STATE } from "../lib/contentTrialsStore";
import type { ContentSubsection } from "../lib/settingsNav";
import type { ContentTrial, CreateContentTrialBody } from "../types";

/** 実行中に一覧を取り直す間隔。画面を離れていても結果を拾えるよう、開いている間だけ回す */
const TRIAL_POLL_INTERVAL_MS = 2_000;

/**
 * 設定 → コンテンツ生成の試行ジョブの state。一覧は画面が開いている間だけ取り、
 * 実行中の試行がある間はポーリングする（取得順と注記の規則は `client/src/lib/contentTrialsStore.ts`）。
 */
export function useContentTrials({ activeSubsection }: { activeSubsection: ContentSubsection }) {
  const [state, setState] = useState(INITIAL_CONTENT_TRIALS_STATE);
  const controller = useRef<ReturnType<typeof createContentTrialsController> | null>(null);

  useEffect(() => {
    const current = createContentTrialsController({
      list: listContentTrials,
      start: startContentTrial,
      cancel: cancelContentTrial,
      remove: deleteContentTrial,
      removeAll: deleteAllContentTrials,
      onChange: setState,
    });
    controller.current = current;
    void current.reload();
    return () => {
      current.dispose();
      controller.current = null;
    };
  }, []);

  // 開いたタブの新着の印は消す。判定は controller が現行の一覧と突き合わせて行う
  useEffect(() => {
    controller.current?.setActiveSubsection(activeSubsection);
  }, [activeSubsection]);

  // 実行中の試行がある間だけ取り直す。1 回の取得が終わってから次を予約し、GET を積み上げない
  const running = state.running;
  useEffect(() => {
    if (!running) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = () => {
      timer = setTimeout(() => {
        void controller.current?.reload().finally(() => {
          if (!stopped) tick();
        });
      }, TRIAL_POLL_INTERVAL_MS);
    };
    tick();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [running]);

  const reload = useCallback(async (): Promise<boolean> => (await controller.current?.reload()) ?? false, []);
  const start = useCallback(
    async (input: CreateContentTrialBody): Promise<boolean> => (await controller.current?.start(input)) ?? false,
    [],
  );
  const cancel = useCallback(
    async (id: string): Promise<boolean> => (await controller.current?.cancel(id)) ?? false,
    [],
  );
  const remove = useCallback(
    async (id: string): Promise<boolean> => (await controller.current?.remove(id)) ?? false,
    [],
  );
  const removeAll = useCallback(
    async (kind: ContentTrial["kind"]): Promise<boolean> => (await controller.current?.removeAll(kind)) ?? false,
    [],
  );

  return {
    /** 一覧を取得できていない間は null */
    trials: state.trials,
    keyEpoch: state.keyEpoch,
    /** 保存容量（`succeeded` + 保存済みの件数とバイト数） */
    artifactUsage: state.artifactUsage,
    note: state.note,
    busy: state.busy,
    newResults: state.newResults,
    running,
    reload,
    start,
    cancel,
    remove,
    removeAll,
  };
}

export type ContentTrials = ReturnType<typeof useContentTrials>;
