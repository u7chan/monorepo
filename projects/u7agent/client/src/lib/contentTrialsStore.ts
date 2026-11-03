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
  ContentTrialSummary,
  CreateContentTrialBody,
} from "../types";
import {
  appendTrialSummaries,
  hasRunningTrial,
  mergeTrialSummaries,
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
  trials: ContentTrialSummary[] | null;
  keyEpoch: number;
  artifactUsage: ContentTrialArtifactUsageValue;
  note: ContentTrialsNote | null;
  busy: boolean;
  /** 別のタブで終端した試行の種別。そのタブを開いたら消す */
  newResults: readonly ContentSubsection[];
  /** 実行中の試行があるか（ポーリングの要否） */
  running: boolean;
  /** 続きのページがあるか */
  hasMore: boolean;
  /** 追加読み込みの実行中 */
  loadingMore: boolean;
  /** 選択中の試行の全文。未選択 / 取得中は null */
  detail: ContentTrial | null;
}

export const INITIAL_CONTENT_TRIALS_STATE: ContentTrialsState = {
  trials: null,
  keyEpoch: 0,
  artifactUsage: { count: 0, bytes: 0 },
  note: null,
  busy: false,
  newResults: [],
  running: false,
  hasMore: false,
  loadingMore: false,
  detail: null,
};

/** 1 ページの件数。履歴は画面で読み進める前提にして、初回と再読み込みの payload を抑える */
export const CONTENT_TRIALS_PAGE_SIZE = 20;

/** 選択行の全文を残す件数。行を渡り歩いてもメモリを増やし続けない */
const DETAIL_CACHE_SIZE = 20;

export interface ContentTrialsQuery {
  kind?: string;
  limit?: number;
  before?: string;
  state?: "running";
}

/**
 * 一覧の取得と試行の操作。**一覧の応答は要求の世代で捨てる**（遅い応答で表示を戻さない）。
 * 開始 / 中断は一覧の取得より新しい状態を生むため、応答を適用する前に世代を進める
 * （取得の開始後に始めた試行が、その取得の応答で消えないようにする）。
 * 一覧は種別ごとのページと、全種別の実行中の行を重ねて持つ（実行中のポーリングは `running` だけを取る）。
 */
export function createContentTrialsController(deps: {
  list: (query: ContentTrialsQuery) => Promise<ContentTrialListResponse>;
  /** 全種別の実行中の行。別の種別の試行が終わっても画面のタブの印を追随させる */
  listRunning: () => Promise<ContentTrialListResponse>;
  get: (id: string) => Promise<ContentTrialResponse>;
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
  /**
   * 一覧を取っている種別。設定タブの切り替えで入れ替える。`null` は全種別
   * （未設定で履歴だけを見せる間は、タブを出すために種別で絞らない）。
   */
  let kind: ContentTrial["kind"] | null = null;
  /** 続きの位置。`null` は「先頭から取った」を表す */
  let nextBefore: string | null = null;
  let selectedId: string | null = null;
  /** 全文の控え（選択行と、履歴行から再実行する行） */
  const details = new Map<string, ContentTrial>();

  /** 一覧のページの要求。種別を絞るのは設定タブを開いている間だけ */
  const pageQuery = (): ContentTrialsQuery => ({
    limit: CONTENT_TRIALS_PAGE_SIZE,
    ...(kind === null ? {} : { kind }),
  });

  const update = (patch: Partial<ContentTrialsState>) => {
    if (!active) return;
    state = { ...state, ...patch };
    if (patch.trials !== undefined) {
      state = { ...state, running: state.trials !== null && hasRunningTrial(state.trials) };
    }
    deps.onChange(state);
  };

  const rememberDetail = (trial: ContentTrial): ContentTrial => {
    details.delete(trial.id);
    details.set(trial.id, trial);
    if (details.size > DETAIL_CACHE_SIZE) {
      const oldest = details.keys().next().value;
      if (oldest !== undefined) details.delete(oldest);
    }
    return trial;
  };

  const apply = (next: ContentTrialSummary[], nextKeyEpoch: number, usage: ContentTrialArtifactUsageValue) => {
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
   * 実行中の行を重ねる。`settle`（ポーリング）のときは、実行中だった行が応答から消えたら終端した
   * （または削除された）とみなして `GET /trials/:id` で確定させる（要約のままだと実行中のまま残り、
   * 履歴が欠ける）。選択行の全文も同じ経路で取り直し、`recorded` の再試行と状態を追随させる。
   * 一覧の取得では、ページ外の古い行を巻き込まないよう確定させない。
   */
  const applyRunning = async (generation: number, options: { settle: boolean }): Promise<void> => {
    const response = await deps.listRunning();
    if (!active || issued !== generation) return;
    const runningIds = new Set(response.items.map((trial) => trial.id));
    const vanished = options.settle
      ? (state.trials ?? []).filter((trial) => trial.state === "running" && !runningIds.has(trial.id))
      : [];
    const lookups = new Set(vanished.map((trial) => trial.id));
    if (options.settle && selectedId !== null) lookups.add(selectedId);
    const settled = await Promise.all(
      [...lookups].map(async (id) => {
        try {
          return rememberDetail((await deps.get(id)).trial);
        } catch {
          return null;
        }
      }),
    );
    if (!active || issued !== generation) return;
    const known = settled.filter((trial): trial is ContentTrial => trial !== null);
    const removed = new Set(
      [...lookups].filter(
        (id) =>
          !known.some((candidate) => candidate.id === id) &&
          (id === selectedId || vanished.some((trial) => trial.id === id)),
      ),
    );
    const merged = mergeTrialSummaries(state.trials ?? [], [...response.items, ...known]).filter(
      (trial) => !removed.has(trial.id),
    );
    apply(merged, response.keyEpoch, response.artifactUsage);
    if (selectedId !== null) {
      const detail = details.get(selectedId) ?? null;
      if (detail !== state.detail) update({ detail });
    }
  };

  /**
   * 一覧を取り直す（先頭ページ + 実行中の行）。後から始めた取得 / 開始 / 中断があるときと、
   * unmount 後は応答を適用しない。`quiet` は操作の注記を取得の失敗で上書きしないための指定。
   */
  const load = async (options: { quiet?: boolean } = {}): Promise<boolean> => {
    const request = ++issued;
    try {
      const response = await deps.list(pageQuery());
      if (!active || request !== issued) return false;
      nextBefore = response.nextBefore;
      apply(response.items, response.keyEpoch, response.artifactUsage);
      update({ hasMore: response.hasMore });
      // 別種別の実行中の行は一覧に載らないため、タブの印とポーリングの判定のために重ねる
      await applyRunning(request, { settle: false });
      return true;
    } catch (error) {
      if (active && request === issued && !options.quiet) {
        update({ note: { text: `試行の履歴を取得できませんでした。${messageFor(error)}`, error: true } });
      }
      return false;
    }
  };

  /** 続きのページを末尾に足す。取り直しと競合したときは何もしない（次の再読み込みで揃う） */
  const loadMore = async (): Promise<boolean> => {
    if (nextBefore === null || state.loadingMore) return false;
    const request = issued;
    const before = nextBefore;
    update({ loadingMore: true });
    try {
      const response = await deps.list({ ...pageQuery(), before });
      if (!active || issued !== request || nextBefore !== before) return false;
      nextBefore = response.nextBefore;
      apply(appendTrialSummaries(state.trials ?? [], response.items), response.keyEpoch, response.artifactUsage);
      update({ hasMore: response.hasMore });
      return true;
    } catch (error) {
      if (active && issued === request && nextBefore === before) {
        update({ note: { text: `試行の履歴を続けて取得できませんでした。${messageFor(error)}`, error: true } });
      }
      return false;
    } finally {
      update({ loadingMore: false });
    }
  };

  /**
   * 実行中の行だけを取り直す（ポーリング）。2 秒ごとの payload を履歴の件数に比例させないため、
   * 一覧の取得とは別の経路にし、終端した行だけ `GET /trials/:id` で確定させる。
   */
  const poll = async (): Promise<boolean> => {
    const generation = issued;
    try {
      await applyRunning(generation, { settle: true });
      return issued === generation;
    } catch {
      // 実行中の取り直しの失敗は注記にしない（次のポーリングで回復し、操作の注記を隠さない）
      return false;
    }
  };

  /** 選択行の全文を取る（取得できなければ注記せず null。ビューポートは要約で表示を続ける） */
  const loadDetail = async (id: string): Promise<ContentTrial | null> => {
    const known = details.get(id);
    if (known) {
      if (selectedId === id) update({ detail: known });
      return known;
    }
    try {
      const trial = rememberDetail((await deps.get(id)).trial);
      if (active && selectedId === id) update({ detail: trial });
      return trial;
    } catch {
      return null;
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
      rememberDetail(trial);
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
      rememberDetail(response.trial);
      update({
        trials: (state.trials ?? []).map((trial) => (trial.id === response.trial.id ? response.trial : trial)),
        note: { text: "試行を中断しました。", error: false },
        ...(selectedId === id ? { detail: response.trial } : {}),
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
      details.delete(id);
      if (selectedId === id) update({ detail: null });
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
      details.clear();
      update({ detail: null });
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

  /** 表示する種別を切り替える。一覧は種別ごとのページを取るため、変わったときだけ取り直す */
  const setKind = (next: ContentTrial["kind"] | null): void => {
    if (kind === next) return;
    kind = next;
    nextBefore = null;
    void load({ quiet: true });
  };

  return {
    /** 先頭ページを取り直す（初回・明示の再読み込み・種別の切り替え） */
    open: (next: ContentTrial["kind"] | null): Promise<boolean> => {
      kind = next;
      nextBefore = null;
      return load();
    },
    setKind,
    /** 先頭ページを取り直す（明示の再読み込み） */
    reload: () => load(),
    loadMore,
    poll,
    loadDetail,
    start,
    cancel,
    remove,
    removeAll,
    /** 表示する試行を選ぶ。全文は `detail` で返す（取得は非同期） */
    select: (id: string | null): void => {
      selectedId = id;
      if (id === null) {
        update({ detail: null });
        return;
      }
      update({ detail: details.get(id) ?? null });
      void loadDetail(id);
    },
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
