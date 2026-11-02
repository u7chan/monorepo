/**
 * 設定 → コンテンツ生成の試行ジョブの表示変換。DOM に依存しない純関数だけを置き、
 * 状態ラベル・証拠の判定・タブの印の優先順位・履歴の行をテストできるようにする。
 */
import type { ContentSubsection } from "./settingsNav";
import type { ContentTrial, ContentTrialStateValue } from "../types";
import { messageTimeLabel, type MessageTimeOptions } from "./messageTime";
import { formatDurationMs } from "./usageFormat";

/** 状態の表示名。`interrupted` は再起動で実行中を持ち越せなかったことを表す */
export const TRIAL_STATE_LABELS: Record<ContentTrialStateValue, string> = {
  running: "実行中",
  succeeded: "成功",
  failed: "失敗",
  canceled: "中止",
  interrupted: "中断（再起動）",
};

/** provider の失敗分類の表示名。分類できない失敗は `unknown` */
export const TRIAL_FAILURE_LABELS: Record<string, string> = {
  invalid_key: "APIキーが無効",
  insufficient_credit: "残高不足",
  rate_limited: "混雑・レート制限",
  timeout: "タイムアウト",
  aborted: "中断",
  unknown: "原因不明",
};

export function trialStateLabel(state: ContentTrialStateValue): string {
  return TRIAL_STATE_LABELS[state];
}

/** 失敗の分類。分類が無い（キャンセル・中断）ときは null */
export function trialFailureLabel(code: string | null): string | null {
  if (code === null) return null;
  return TRIAL_FAILURE_LABELS[code] ?? TRIAL_FAILURE_LABELS.unknown;
}

/**
 * 証拠の時刻。相対表記は「たった今 / N 分前 / N 時間前 / N 日前」だけにし、それより古いものは
 * 日付（今日なら時刻）へ落とす。分単位の表記は履歴の比較に要る粒度で、秒は出さない。
 */
export function trialAgeLabel(at: number, now: number, options: MessageTimeOptions = {}): string {
  const diff = now - at;
  if (diff < 60_000) return "たった今";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 時間前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 日前`;
  return messageTimeLabel(at, { ...options, now });
}

/** 所要時間。分からない（中断・記録前）ときは `—`。前回の実測だけを出し、平均は出さない */
export function trialDurationLabel(durationMs: number | null): string {
  return durationMs === null ? "—" : formatDurationMs(durationMs);
}

/** 証拠の判定。現在のキー世代と選択中のモデルに一致する実績だけを数える */
export type TrialEvidence =
  | { kind: "success"; at: number; durationMs: number | null }
  | { kind: "failure"; at: number; code: string | null; message: string | null }
  | { kind: "unverified" };

/**
 * モデル選択の直下に出す証拠。現在のキー世代・現在のモデルの `succeeded` が最新なら成功、
 * 無ければ同じ条件の `failed` の最新を出し、どちらも無ければ未確認にする（緑のバッジは作らない）。
 * 旧キー・別モデルの実績は履歴にだけ残し、現在の証拠にしない。
 */
export function imageTrialEvidence(input: {
  trials: readonly ContentTrial[];
  currentKeyEpoch: number;
  currentModel: string;
  now: number;
}): TrialEvidence {
  const current = input.trials.filter(
    (trial) => trial.keyEpoch === input.currentKeyEpoch && trial.model === input.currentModel,
  );
  const at = (trial: ContentTrial): number => trial.finishedAt ?? trial.startedAt;
  const succeeded = current.filter((trial) => trial.state === "succeeded").sort((a, b) => at(b) - at(a))[0];
  if (succeeded) {
    return { kind: "success", at: at(succeeded), durationMs: succeeded.durationMs };
  }
  const failed = current.filter((trial) => trial.state === "failed").sort((a, b) => at(b) - at(a))[0];
  if (failed) {
    return { kind: "failure", at: at(failed), code: failed.failureCode, message: failed.failureMessage };
  }
  return { kind: "unverified" };
}

/**
 * 証拠の 1 行。成功には所要時間を添え、段階 1（成果物なし）では結果が保存されていないことを明示する。
 * 分類の文言は provider の原文ではなく固定の短い名前を使う（原文は履歴の行に出す）。
 */
export function evidenceNote(
  evidence: TrialEvidence,
  options: { now: number; messageTime?: MessageTimeOptions },
): string {
  if (evidence.kind === "unverified") return "この画面での成功: 未確認";
  const age = trialAgeLabel(evidence.at, options.now, options.messageTime);
  if (evidence.kind === "failure") {
    const label = trialFailureLabel(evidence.code) ?? "原因不明";
    return `直近の失敗: ${label}（${age}）`;
  }
  const duration = evidence.durationMs === null ? "" : `（${trialDurationLabel(evidence.durationMs)}）`;
  return `この画面での最終成功: ${age}${duration}。結果は保存されていません`;
}

/** 履歴の 1 行。現在のキー世代より古い行は「旧キー」として区別する */
export interface TrialHistoryRow {
  id: string;
  stateLabel: string;
  state: ContentTrialStateValue;
  model: string;
  durationLabel: string;
  keyEpochLabel: string | null;
  prompt: string;
  failureLabel: string | null;
  at: number;
}

export function trialHistoryRow(trial: ContentTrial, currentKeyEpoch: number): TrialHistoryRow {
  return {
    id: trial.id,
    state: trial.state,
    stateLabel: trialStateLabel(trial.state),
    model: trial.model,
    durationLabel: trialDurationLabel(trial.durationMs),
    keyEpochLabel: trial.keyEpoch < currentKeyEpoch ? `旧キー（世代 ${trial.keyEpoch}）` : null,
    prompt: trial.prompt,
    failureLabel: trialFailureLabel(trial.failureCode),
    at: trial.finishedAt ?? trial.startedAt,
  };
}

/**
 * 試行の面の状態。未設定 / runtime 不可 / 全体 OFF / 同期未確認 / 空 / 実行中 / 失敗 / 中断の
 * どれを主に出すかを 1 箇所で決める（文言は呼び出し側が写す）。
 */
export type TrialPanelState =
  | "runtime_unavailable"
  | "unconfigured"
  | "disabled"
  | "unsynced"
  | "empty"
  | "running"
  | "failed"
  | "interrupted"
  | "ready";

export function trialPanelState(input: {
  runtimeAvailable: boolean;
  configured: boolean;
  enabled: boolean;
  /** 音声の同期が確認できていない。画像の面では常に true */
  synced: boolean;
  trials: readonly ContentTrial[];
}): TrialPanelState {
  if (!input.runtimeAvailable) return "runtime_unavailable";
  if (!input.configured) return "unconfigured";
  // 同期未確認は保存だけを止める状態で、試行は画面の値でできる（面では注記に留める）
  if (!input.synced) return "unsynced";
  if (!input.enabled) return "disabled";
  if (input.trials.some((trial) => trial.state === "running")) return "running";
  const latest = input.trials[0];
  if (!latest) return "empty";
  if (latest.state === "failed") return "failed";
  if (latest.state === "interrupted") return "interrupted";
  return "ready";
}

/** 試行を開始できない理由。null なら開始できる */
export function trialStartBlockedReason(input: {
  runtimeAvailable: boolean;
  configured: boolean;
  enabled: boolean;
  keyAvailable: boolean;
  running: boolean;
  prompt: string;
}): string | null {
  if (!input.runtimeAvailable) return "ランタイムが利用できないため試行できません";
  if (!input.configured) return "APIキーを登録すると試行できます";
  if (!input.enabled) return "全体が OFF のため試行できません（履歴は残ります）";
  if (!input.keyAvailable) return "保存済みのAPIキーを使えないため試行できません";
  if (input.running) return "実行中です。完了するか中断してください";
  if (input.prompt.trim() === "") return "プロンプトを入力してください";
  return null;
}

/** 試行の種別と設定タブの対応。印はタブ単位で出す */
export function trialKindSubsection(kind: ContentTrial["kind"]): ContentSubsection {
  switch (kind) {
    case "image":
      return "image";
  }
}

/**
 * タブの印。優先順位は 実行中（accent の点 + pulse）> 同期未確認（warn の点、開いても消えない）>
 * 新着結果（warn の点、開いたら消える）。読み上げ名も状態ごとに分ける。
 */
export interface TabIndicator {
  dot: "accent" | "warn" | null;
  pulse: boolean;
  ariaLabel: string | null;
}

export function tabIndicator(input: {
  label: string;
  running: boolean;
  unsynced: boolean;
  newResult: boolean;
}): TabIndicator {
  if (input.running) return { dot: "accent", pulse: true, ariaLabel: `${input.label}（生成中）` };
  if (input.unsynced) return { dot: "warn", pulse: false, ariaLabel: `${input.label}（現在の設定を確認できません）` };
  if (input.newResult) return { dot: "warn", pulse: false, ariaLabel: `${input.label}（新しい結果があります）` };
  return { dot: null, pulse: false, ariaLabel: null };
}

/**
 * 新しく終端した試行の種別。前回の一覧で `running` だった行が今回の一覧で終端になり、かつ
 * その種別のタブが開いていなければ「新着結果」として印を出す（ページ再訪時は前回の一覧が無いので出ない）。
 */
export function newlyFinishedKinds(input: {
  previous: readonly ContentTrial[] | null;
  next: readonly ContentTrial[];
  activeSubsection: ContentSubsection | null;
}): ContentTrial["kind"][] {
  if (input.previous === null) return [];
  const wasRunning = new Set(input.previous.filter((trial) => trial.state === "running").map((trial) => trial.id));
  const kinds = new Set<ContentTrial["kind"]>();
  for (const trial of input.next) {
    if (trial.state === "running") continue;
    if (!wasRunning.has(trial.id)) continue;
    const subsection = trialKindSubsection(trial.kind);
    if (subsection === input.activeSubsection) continue;
    kinds.add(trial.kind);
  }
  return [...kinds];
}

/** 実行中の試行が 1 件でもあるか。ポーリングの要否を決める */
export function hasRunningTrial(trials: readonly ContentTrial[]): boolean {
  return trials.some((trial) => trial.state === "running");
}

/** 履歴に出す最新の試行。既定選択は最新 1 件 */
export function latestTrial(trials: readonly ContentTrial[]): ContentTrial | null {
  return trials[0] ?? null;
}
