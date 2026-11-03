/**
 * 設定 → コンテンツ生成の試行の state と操作。DOM に依存させず、一覧の取得順・注記・実行中の判定を
 * `client/src/hooks/useContentTrials.ts` から切り離してテストできるようにする。
 * 一覧は画面が開いている間だけ取り、実行中の試行がある間は呼び出し側がポーリングする。
 */
import type { ContentSubsection } from "./settingsNav";
import type {
  ContentTrial,
  ContentTrialArtifactUsageValue,
  ContentTrialDeleteResponse,
  ContentTrialListResponse,
  ContentTrialResponse,
  ContentTrialStartResponse,
  CreateContentTrialBody,
} from "../types";
import {
  hasRunningTrial,
  newlyFinishedKinds,
  removeTrialThenRefresh,
  trialKindLabel,
  trialKindSubsection,
  trialRemoveAllNote,
} from "./contentTrials";
import { messageFor } from "./settingsResource";

export interface ContentTrialsNote {
  text: string;
  error: boolean;
}

export interface ContentTrialsState {
  /** 一覧を取得できていない間は null */
  trials: ContentTrial[] | null;
  keyEpoch: number;
  artifactUsage: ContentTrialArtifactUsageValue;
  note: ContentTrialsNote | null;
  busy: boolean;
  /** 別のタブで終端した試行の種別。そのタブを開いたら消す */
  newResults: readonly ContentSubsection[];
  /** 実行中の試行があるか（ポーリングの要否） */
  running: boolean;
}

export const INITIAL_CONTENT_TRIALS_STATE: ContentTrialsState = {
  trials: null,
  keyEpoch: 0,
  artifactUsage: { count: 0, bytes: 0 },
  note: null,
  busy: false,
  newResults: [],
  running: false,
};

/**
 * 一覧の取得と試行の操作。**一覧の応答は要求の世代で捨てる**（遅い応答で表示を戻さない）。
 * 開始 / 中断は一覧の取得より新しい状態を生むため、応答を適用する前に世代を進める
 * （取得の開始後に始めた試行が、その取得の応答で消えないようにする）。
 */
export function createContentTrialsController(deps: {
  list: () => Promise<ContentTrialListResponse>;
  start: (input: CreateContentTrialBody) => Promise<ContentTrialStartResponse>;
  cancel: (id: string) => Promise<ContentTrialResponse>;
  remove: (id: string) => Promise<ContentTrialDeleteResponse>;
  removeAll: (kind: ContentTrial["kind"]) => Promise<ContentTrialDeleteResponse>;
  onChange: (state: ContentTrialsState) => void;
}) {
  let state = INITIAL_CONTENT_TRIALS_STATE;
  let active = true;
  let issued = 0;
  let activeSubsection: ContentSubsection | null = null;

  const update = (patch: Partial<ContentTrialsState>) => {
    if (!active) return;
    state = { ...state, ...patch };
    if (patch.trials !== undefined) {
      state = { ...state, running: state.trials !== null && hasRunningTrial(state.trials) };
    }
    deps.onChange(state);
  };

  const apply = (next: ContentTrial[], nextKeyEpoch: number, usage: ContentTrialArtifactUsageValue) => {
    const finished = newlyFinishedKinds({ previous: state.trials, next, activeSubsection });
    update({
      trials: next,
      keyEpoch: nextKeyEpoch,
      artifactUsage: usage,
      newResults:
        finished.length === 0
          ? state.newResults
          : [...new Set([...state.newResults, ...finished.map(trialKindSubsection)])],
    });
  };

  /**
   * 一覧を取り直す。後から始めた取得 / 開始 / 中断があるときと、unmount 後は応答を適用しない。
   * `quiet` は操作の注記を取得の失敗で上書きしないための指定（ポーリングと明示の再読み込みは出し続ける）。
   */
  const load = async (options: { quiet?: boolean } = {}): Promise<boolean> => {
    const request = ++issued;
    try {
      const response = await deps.list();
      if (!active || request !== issued) return false;
      apply(response.items, response.keyEpoch, response.artifactUsage);
      return true;
    } catch (error) {
      if (active && request === issued && !options.quiet) {
        update({ note: { text: `試行の履歴を取得できませんでした。${messageFor(error)}`, error: true } });
      }
      return false;
    }
  };

  const start = async (input: CreateContentTrialBody): Promise<boolean> => {
    update({ busy: true });
    try {
      const response = await deps.start(input);
      if (!active) return true;
      // 取得の開始後に始めた試行の状態を、遅れて届く一覧の応答で巻き戻さない
      issued += 1;
      // 再利用は「同じ入力の保存済み結果」を返す。新しい成功として積まず、既存の行を差し替える
      const trial = response.trial;
      const list = state.trials ?? [];
      update({
        trials: list.some((item) => item.id === trial.id)
          ? list.map((item) => (item.id === trial.id ? trial : item))
          : [trial, ...list],
        note: {
          text: response.reused
            ? "同じ入力の保存済みの結果を表示しています（課金していません）。"
            : "試行を開始しました。画面を離れても続きます。",
          error: false,
        },
      });
      // 一覧（保存容量を含む）を権威ある状態へ揃える。取り直せなくても積んだ行で実行中の判定はできる
      void load({ quiet: true });
      return true;
    } catch (error) {
      if (active) update({ note: { text: `試行を開始できませんでした。${messageFor(error)}`, error: true } });
      return false;
    } finally {
      update({ busy: false });
    }
  };

  const cancel = async (id: string): Promise<boolean> => {
    update({ busy: true });
    try {
      const response = await deps.cancel(id);
      if (!active) return true;
      // 開始と同じく、取得の開始後に起きた中断を一覧の応答で巻き戻さない
      issued += 1;
      update({
        trials: (state.trials ?? []).map((trial) => (trial.id === response.trial.id ? response.trial : trial)),
        note: { text: "試行を中断しました。", error: false },
      });
      void load({ quiet: true });
      return true;
    } catch (error) {
      if (active) update({ note: { text: `試行を中断できませんでした。${messageFor(error)}`, error: true } });
      // すでに終端していた可能性があるので、表示は権威ある一覧へ揃える
      void load({ quiet: true });
      return false;
    } finally {
      update({ busy: false });
    }
  };

  const remove = async (id: string): Promise<boolean> => {
    update({ busy: true });
    try {
      // 行だけをローカルで除くと保存容量（一覧の応答にしか載らない）が古いまま残るため、必ず取り直す
      const refreshed = await removeTrialThenRefresh({ id, remove: deps.remove, reload: () => load() });
      if (!active) return true;
      update({
        note: refreshed
          ? { text: "試行の履歴を削除しました。", error: false }
          : {
              text: "試行の履歴は削除しましたが、一覧を取り直せませんでした。再読み込みしてください。",
              error: true,
            },
      });
      return true;
    } catch (error) {
      if (active) update({ note: { text: `試行の履歴を削除できませんでした。${messageFor(error)}`, error: true } });
      void load();
      return false;
    } finally {
      update({ busy: false });
    }
  };

  /**
   * 種別ごとの全削除。面は自分の種別の履歴しか見せないため、種別を渡さずに消すと
   * もう一方のタブの履歴と保存容量まで消える（API の `?kind=` で絞る）。
   */
  const removeAll = async (kind: ContentTrial["kind"]): Promise<boolean> => {
    update({ busy: true });
    try {
      const response = await deps.removeAll(kind);
      if (!active) return true;
      await load();
      update({ note: { text: trialRemoveAllNote(kind, response.removed), error: false } });
      return true;
    } catch (error) {
      if (active) {
        update({
          note: {
            text: `${trialKindLabel(kind)}の試行の履歴を削除できませんでした。${messageFor(error)}`,
            error: true,
          },
        });
      }
      return false;
    } finally {
      update({ busy: false });
    }
  };

  return {
    /** 一覧を取り直す（明示の再読み込みとポーリング） */
    reload: () => load(),
    start,
    cancel,
    remove,
    removeAll,
    /** 開いたタブの新着の印は消す（ページ再訪時に残さない） */
    setActiveSubsection: (next: ContentSubsection) => {
      activeSubsection = next;
      if (state.newResults.includes(next)) {
        update({ newResults: state.newResults.filter((item) => item !== next) });
      }
    },
    dispose: () => {
      active = false;
    },
  };
}

export type ContentTrialsController = ReturnType<typeof createContentTrialsController>;
