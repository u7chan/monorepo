import type { ReactNode } from "react";
import { useMessageCopy } from "../../hooks/useMessageCopy";
import { trialArtifactUrl, trialHistoryRow } from "../../lib/contentTrials";
import { cn } from "../../lib/cn";
import type { ContentTrialSummary } from "../../types";
import { CopyButton } from "../chat/CopyButton";
import { DownloadIcon, PencilIcon, RefreshIcon, TrashIcon } from "../icons";

/**
 * 1 つの結果。生成タブの直近の結果（`latest`）と、履歴タブの詳細（`history`）で同じ骨格を使う。
 * 状態・失敗・課金・送った内容・成果物は共通で、面ごとに違うのは成果物の見せ方と、
 * 結果から次へ進む導線（既定へ保存 / この内容で編集 / もう一度生成）だけにする。
 *
 * `latest` は生成直後に同じ画面で閉じるためのカードなので、入力欄へ戻す導線は置かない
 * （プロンプトの入力欄はすぐ上にある）。`history` は履歴を読む面なので、プロンプトのコピーと
 * 「この内容で編集」を出す。
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
  /** 全文を取得できているか。false の間は抜粋と明示し、コピーを出さない */
  promptComplete = true,
  /** 送った内容に添える面固有の 1 行（音声の演技指示と話速）。無い面は省略 */
  promptDetail,
  /** 履歴の詳細に出すパラメータ表（形式・実寸・サイズなど）。生成タブの直近の結果では省略する */
  params,
  /** 結果から既定へ保存する導線（画像・音声だけ）。BGM は保存する設定を持たない */
  defaultAction,
  /** この内容を生成タブの入力欄へ戻す（履歴だけ）。生成タブは入力欄が同じ画面にあるため渡さない */
  onPrefill,
  /** もう一度生成する（履歴だけ）。確認のうえ新しい試行として課金される */
  onAnotherTake,
  onDelete,
  variant = "history",
}: {
  trial: ContentTrialSummary;
  currentKeyEpoch: number;
  busy: boolean;
  /** 同じ種別の実行中の試行があるか（もう一度生成を重ねない） */
  running: boolean;
  sentNoun: string;
  chips?: readonly string[];
  artifact: ReactNode | null;
  prompt: string;
  /** 全文を取得できているか。false の間は抜粋と明示し、コピーを出さない（欠けた文面をコピーさせない） */
  promptComplete?: boolean;
  promptDetail?: string;
  params?: ReactNode;
  defaultAction?: ReactNode;
  onPrefill?: () => Promise<void>;
  onAnotherTake?: () => Promise<void>;
  onDelete: (id: string) => Promise<boolean>;
  variant?: "latest" | "history";
}) {
  const row = trialHistoryRow(trial, currentKeyEpoch);
  const { copiedId, copyMessage, copyFailure } = useMessageCopy(trial.id);
  const copyId = "prompt";
  const latest = variant === "latest";

  return (
    <div className={cn("grid gap-2", latest && "rounded-lg border border-line bg-soft p-3")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs font-semibold text-ink-strong">{latest ? "直近の結果" : "結果"}</span>
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

      <div className="grid gap-1">
        <div className="flex items-center gap-2">
          <span className="text-2xs font-semibold text-ink-faint">
            送った{sentNoun}
            {promptComplete ? null : "（抜粋）"}
          </span>
          <span className="flex-1" />
          {promptComplete ? (
            <CopyButton
              copied={copiedId === copyId}
              failure={copyFailure(copyId)}
              onClick={() => void copyMessage(prompt, copyId)}
              label={`送った${sentNoun}をコピー`}
              compact
            />
          ) : null}
        </div>
        <p className="rounded-lg border border-line bg-base px-2.5 py-2 text-2xs break-words whitespace-pre-wrap text-ink">
          {prompt}
        </p>
        {promptDetail === undefined ? null : <p className="text-2xs text-ink-muted">{promptDetail}</p>}
        {promptComplete ? null : (
          <p className="text-2xs text-ink-faint">全文を取得中です。取得できるまでコピーはできません。</p>
        )}
      </div>

      {params}

      <div className="flex flex-wrap items-center gap-2">
        {onPrefill === undefined ? null : (
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void onPrefill()}>
            <PencilIcon />
            この内容で編集
          </button>
        )}
        {onAnotherTake === undefined ? null : (
          <button type="button" className="btn-quiet" disabled={busy || running} onClick={() => void onAnotherTake()}>
            <RefreshIcon />
            もう一度生成
          </button>
        )}
        {/* 直近の結果は「既定にする / 削除」の 2 つだけ。履歴は保存の導線を下の行へ分ける */}
        {latest ? defaultAction : null}
        {latest ? null : <span className="flex-1" />}
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
      {latest ? null : defaultAction}
      {latest ? null : (
        <p className="text-2xs leading-relaxed text-ink-faint">
          もう一度生成は確認のうえ新しい試行として課金されます。
        </p>
      )}
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
          <DownloadIcon small />
          ダウンロード
        </a>
      </div>
      {children}
    </>
  );
}
