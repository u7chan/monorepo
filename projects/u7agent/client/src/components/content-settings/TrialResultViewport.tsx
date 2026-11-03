import type { ReactNode } from "react";
import { trialArtifactUrl, trialHistoryRow } from "../../lib/contentTrials";
import { cn } from "../../lib/cn";
import type { ContentTrialSummary } from "../../types";
import { TrashIcon } from "../icons";

/**
 * 1 つの結果ビューポート。表示中の試行のスナップショットだけを出し、下書きの入力とは混ぜない。
 * 成果物の再生・プレビューだけを面ごとに渡し、状態・失敗・課金・送った内容・導線の並びはここで揃える。
 */
export function TrialResultViewport({
  trial,
  currentKeyEpoch,
  busy,
  running,
  /** 生成中に「送信した何を表示しているか」の呼び名（画像 / BGM はプロンプト、音声は本文） */
  sentNoun,
  /** 状態・モデルのあとに足す面固有の値（音声のボイスなど）。無い面は省略 */
  chips,
  /** 保存済みの成果物の表示。保存が無い行は null で、記録のみ / 実行中 / 結果なしの案内をここで出す */
  artifact,
  /** 送った内容の本体（全文を取れるまでは一覧の抜粋） */
  prompt,
  /** 送った内容に添える面固有の 1 行（音声の演技指示と話速）。無い面は省略 */
  promptDetail,
  /** 結果から既定へ保存する導線（画像・音声だけ）。BGM は保存する設定を持たない */
  defaultAction,
  onDelete,
  onRestore,
  onAnotherTake,
}: {
  trial: ContentTrialSummary;
  currentKeyEpoch: number;
  busy: boolean;
  /** 同じ種別の実行中の試行があるか（別のテイクを重ねない） */
  running: boolean;
  sentNoun: string;
  chips?: readonly string[];
  artifact: ReactNode | null;
  prompt: string;
  promptDetail?: string;
  defaultAction?: ReactNode;
  onDelete: (id: string) => Promise<boolean>;
  onRestore: () => Promise<void>;
  onAnotherTake: () => Promise<void>;
}) {
  const row = trialHistoryRow(trial, currentKeyEpoch);

  return (
    <div className="grid gap-2 rounded-lg border border-line bg-soft p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs font-semibold text-ink-strong">結果</span>
        <span className={cn("text-2xs", trial.state === "failed" ? "text-warn" : "text-ink-muted")}>
          {row.stateLabel}
        </span>
        <code className="text-2xs text-ink-ghost">{row.model}</code>
        {(chips ?? []).map((chip) => (
          <span key={chip} className="text-2xs text-ink-muted">
            {chip}
          </span>
        ))}
        <span className="text-2xs text-ink-muted">{row.durationLabel}</span>
        {row.keyEpochLabel ? <span className="text-2xs text-warn">{row.keyEpochLabel}</span> : null}
        {trial.recorded ? null : <span className="text-2xs text-warn">状態を記録できませんでした</span>}
      </div>

      {artifact !== null ? (
        artifact
      ) : trial.state === "running" ? (
        <p className="text-2xs text-ink-muted" role="status">
          生成中です。送信した{sentNoun}を表示しています（入力欄の編集とは別です）。
        </p>
      ) : (
        <p className="text-2xs leading-relaxed text-ink-faint">
          {trial.artifactState === "none" && trial.state === "succeeded"
            ? "結果は保存されていません（記録のみ）。ダウンロードや再生はできません。"
            : "結果は残っていません。"}
        </p>
      )}

      {row.failureLabel ? (
        <p className="text-2xs text-warn">
          失敗の分類: {row.failureLabel}
          {trial.failureMessage ? ` — ${trial.failureMessage}` : ""}
        </p>
      ) : null}
      {row.chargedWithoutArtifact ? (
        <p className="text-2xs text-warn">生成は課金されています。もう一度生成すると再課金されます。</p>
      ) : null}

      <div className="grid gap-0.5">
        <p className="text-2xs break-words whitespace-pre-wrap text-ink">{prompt}</p>
        {promptDetail === undefined ? null : <p className="text-2xs text-ink-muted">{promptDetail}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-quiet" disabled={busy} onClick={onRestore}>
          入力欄に戻す
        </button>
        <button type="button" className="btn-quiet" disabled={busy || running} onClick={onAnotherTake}>
          別のテイクを生成
        </button>
        <button
          type="button"
          className="btn-quiet"
          disabled={busy || trial.state === "running"}
          onClick={() => void onDelete(trial.id)}
        >
          <TrashIcon />
          削除
        </button>
      </div>
      {/* 下書きを捨てるのは呼び出し側。ここは保存の進行と失敗の注記だけを持つ */}
      {defaultAction}
      <p className="text-2xs leading-relaxed text-ink-faint">別のテイクは新しい試行として課金されます。</p>
    </div>
  );
}

/**
 * 成果物のメタ行（形式・サイズとダウンロード）。再生・プレビューそのものは面ごとに違い、
 * この行だけは 3 タブで同じ URL の組み立てを使う。
 */
export function TrialArtifactMeta({
  trialId,
  label,
  children,
}: {
  trialId: string;
  /** 形式・実寸・サイズの 1 行。読めない成果物は null */
  label: string | null;
  /** メタ行の下に足す面固有の注記（実寸が読めない / 実測の尺など） */
  children?: ReactNode;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-2xs text-ink-muted">{label}</span>
        <a className="btn-quiet" href={trialArtifactUrl(trialId, { download: true })}>
          ダウンロード
        </a>
      </div>
      {children}
    </>
  );
}
