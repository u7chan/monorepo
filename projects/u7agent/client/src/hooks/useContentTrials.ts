import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelContentTrial,
  deleteAllContentTrials,
  deleteContentTrial,
  getContentTrial,
  isMissingContentTrial,
  listContentTrials,
  startContentTrial,
} from "../api";
import { trialKindOfSubsection } from "../lib/contentTrials";
import { createContentTrialsController, INITIAL_CONTENT_TRIALS_STATE } from "../lib/contentTrialsStore";
import type { ContentSubsection } from "../lib/settingsNav";
import type { ContentTrial, CreateContentTrialBody } from "../types";

/** 実行中に一覧を取り直す間隔。画面を離れていても結果を拾えるよう、開いている間だけ回す */
const TRIAL_POLL_INTERVAL_MS = 2_000;

/**
 * 設定 → コンテンツ生成の試行ジョブの state。一覧は開いているタブの種別だけを先頭ページから取り、
 * 実行中の試行がある間は `running` の行だけをポーリングする
 * （取得順と注記の規則は `client/src/lib/contentTrialsStore.ts`）。
 */
export function useContentTrials({
  activeSubsection,
  kindScoped = true,
}: {
  activeSubsection: ContentSubsection;
  /** 一覧を開いているタブの種別で絞るか。未設定（履歴だけ見せる）ではタブを出すために絞らない */
  kindScoped?: boolean;
}) {
  const [state, setState] = useState(INITIAL_CONTENT_TRIALS_STATE);
  const controller = useRef<ReturnType<typeof createContentTrialsController> | null>(null);
  const kind = kindScoped ? trialKindOfSubsection(activeSubsection) : null;
  // 初回の種別は controller の作成時にだけ使う（切り替えは下の effect が扱う）
  const initialKind = useRef(kind);

  useEffect(() => {
    const current = createContentTrialsController({
      list: listContentTrials,
      listRunning: () => listContentTrials({ state: "running" }),
      get: getContentTrial,
      isMissing: isMissingContentTrial,
      start: startContentTrial,
      cancel: cancelContentTrial,
      remove: deleteContentTrial,
      removeAll: deleteAllContentTrials,
      onChange: setState,
    });
    controller.current = current;
    void current.open(initialKind.current);
    return () => {
      current.dispose();
      controller.current = null;
    };
  }, []);

  // タブを切り替えたら（種別で絞る場合だけ）、その種別の先頭ページを取り直す
  useEffect(() => {
    controller.current?.setKind(kind);
  }, [kind]);

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
        void controller.current?.poll().finally(() => {
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
  const loadMore = useCallback(async (): Promise<boolean> => (await controller.current?.loadMore()) ?? false, []);
  const selectTrial = useCallback((id: string | null): void => controller.current?.select(id), []);
  const loadTrialDetail = useCallback(
    async (id: string): Promise<ContentTrial | null> => (await controller.current?.loadDetail(id)) ?? null,
    [],
  );
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
    async (target: ContentTrial["kind"]): Promise<boolean> => (await controller.current?.removeAll(target)) ?? false,
    [],
  );

  return {
    /** 一覧（取得できていない間は null）。これは要約で、全文は `detail` と `loadTrialDetail` で取る */
    trials: state.trials,
    keyEpoch: state.keyEpoch,
    /** 保存容量（`succeeded` + 保存済みの件数とバイト数） */
    artifactUsage: state.artifactUsage,
    note: state.note,
    busy: state.busy,
    newResults: state.newResults,
    running,
    /** 続きのページがあるか */
    hasMore: state.hasMore,
    loadingMore: state.loadingMore,
    /** 選択中の試行の全文（選択していない / 取得中は null） */
    detail: state.detail,
    reload,
    loadMore,
    selectTrial,
    loadTrialDetail,
    start,
    cancel,
    remove,
    removeAll,
  };
}

export type ContentTrials = ReturnType<typeof useContentTrials>;
