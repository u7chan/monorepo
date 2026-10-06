import { useId, type CSSProperties } from "react";
import { useElapsedMs } from "../../hooks/useElapsedMs";
import { cn } from "../../lib/cn";
import { formatElapsed } from "../../lib/elapsed";
import {
  blockedButtonsNotice,
  retryableRunError,
  RUN_RETRY_LABEL,
  RUN_RETRY_LABEL_COMPACT,
  RUN_RETRY_NOTE,
  type RunErrorInfo,
} from "../../lib/runRetry";
import { contextGauge } from "../../lib/usageFormat";
import type { ContextUsage, RunStatus } from "../../types";
import { CompactIcon, RunSpinnerIcon } from "../icons";
import { ReloadButton } from "../ReloadButton";

/**
 * 入力欄の上の状態行 (活動 / モデル - Effort / Context ゲージ)。
 * モデル名 (Effort 付き)・ゲージ・圧縮ボタンは 1 つの組にして右端へ寄せ、幅が足りないときだけ組ごと 2 行目へ折り返す
 * (別々に置くと、狭い画面で活動テキストが 1 文字幅まで潰れる。docs/ui-layout.md)。
 * 圧縮の不可逆性と課金の注意は、押した時点の確認 (`App` の handleCompact) が担う。
 * 最終失敗の再実行カードは状態行の上に出し、文言は BFF が合成した 1 文をそのまま使う。
 */
export function ComposerStatus({
  activity,
  activityState,
  runningSince,
  finishedRunDurationMs,
  context,
  model,
  modelLabel,
  effortLabel,
  modelUnavailable = false,
  onCompact,
  compactDisabled = false,
  compactDisabledReason,
  compact = false,
  runStatus = "idle",
  runError,
  onRetry,
  retryDisabled = false,
  retryDisabledReason,
}: {
  activity: string;
  /**
   * 活動表示の由来 (SSE `status` の state)。thinking のときだけ活動ラベルに光を流す
   * (ツール実行中や待機の文言まで流すと、演出ではなく装飾になる。docs/frontend.md)。
   * 由来が付くのは run 自身の短いラベルだけで、復帰の長い文言と再試行の文言には付かない
   * (折り返すと帯が行ごとに切れる。保証するのは chatReducer と App 側)
   */
  activityState?: string;
  /** 実行中 / 圧縮中だけ渡す (活動行の経過時間の起点) */
  runningSince?: number;
  /**
   * 直前に終わったランの合計時間 (run_end のサーバー計測)。渡すと活動の右に凍結表示する。
   * 実行中の `runningSince` と違い値が動かないため、こちらは読み上げの対象にする
   */
  finishedRunDurationMs?: number;
  context?: ContextUsage;
  /** 実効モデルの provider/id。tooltip と折り返し後の切り詰めの確認に使う */
  model?: string;
  /** 状態行に出す表示名。未作成チャットでは「これから使うモデル」になる */
  modelLabel?: string;
  /** 状態行に出す Effort のラベル (モデル名の右へ `- xHigh` と続ける)。推論対応外とモデル未解決では渡さない */
  effortLabel?: string;
  /** 実効モデルが候補に無い (settings.modelWarning がある) とき true */
  modelUnavailable?: boolean;
  /** 手動圧縮。セッションがあるときだけ渡す (未対応ランタイムはサーバーが 501 を返す) */
  onCompact?: () => void;
  compactDisabled?: boolean;
  /** 押せない理由。状態行の下に 1 行で出し、aria-describedby の参照先にもする */
  compactDisabledReason?: string;
  /** 幅の狭いレイアウト。再実行カードのボタンを全幅にする */
  compact?: boolean;
  /** ランがエラーで終わったか。再実行カードの表示条件 (`runStatus === "error"`) に使う */
  runStatus?: RunStatus;
  /** 最後に失敗したランの分類コードと文言。runEnd / resync から保持したもの */
  runError?: RunErrorInfo;
  /** 再実行。固定文言を通常の送信経路で送る */
  onRetry?: () => void;
  retryDisabled?: boolean;
  /** 再実行を押せない理由。圧縮と同じ 1 行にまとめて出す */
  retryDisabledReason?: string;
}) {
  const reasonId = useId();
  // モデルの生成中だけ活動ラベルに光を流す。活動の文言 (activity) で判定しないのは、
  // BFF の文面変更で演出が消えないようにするため (由来はサーバーが配る state)
  const shimmer = activityState === "thinking";
  const gauge = contextGauge(context);
  const elapsedMs = useElapsedMs(runningSince);
  const elapsed = elapsedMs === undefined ? null : formatElapsed(elapsedMs);
  // 確定した合計時間。実行中の経過と違って毎秒変わらないので、活動欄と同じ行に出しつつ読み上げに残す
  const finishedElapsed = finishedRunDurationMs === undefined ? null : formatElapsed(finishedRunDurationMs);
  // 活動が無いときは活動欄ごと出さない (空の欄が折り返して空行が残るのを避ける)
  const showActivity = activity !== "" || elapsed !== null;
  // 再実行カードは時間をおけば回復し得る失敗だけに出す (停止・成功・キュー待ちでは出さない)
  const card = retryableRunError(runStatus, runError);
  const showRetry = card !== undefined && onRetry !== undefined;
  // カードだけの状態でも描画する (activity は空にして文言をカードへ移す)
  if (!showActivity && !gauge && !modelLabel && onCompact === undefined && !showRetry) return null;
  const gaugeColor =
    gauge?.level === "danger" ? "text-danger-text" : gauge?.level === "warn" ? "text-warn" : "text-ink-faint";
  // 押せない理由は状態行の下に 1 行で出す (押せない間の説明を hover だけに閉じると、タッチ端末で読めない)
  const compactBlocked = onCompact !== undefined && compactDisabled && compactDisabledReason !== undefined;
  const retryBlocked = showRetry && retryDisabled && retryDisabledReason !== undefined;
  // 無効な操作と実際の理由だけを並べる (再実行だけが無効なときに圧縮の文言を出さない)
  const blockedNotice = blockedButtonsNotice({
    compact: compactBlocked ? compactDisabledReason : undefined,
    retry: retryBlocked ? retryDisabledReason : undefined,
  });

  return (
    <>
      {showRetry ? (
        // role="alert" は付けない (同じ文言が RuntimeAlert の alert で読み上げられるため)
        <div
          className={cn(
            "mb-1.5 flex border border-danger/35 bg-soft",
            compact ? "flex-col gap-2 rounded-lg px-2.5 py-2" : "items-center gap-2.5 rounded-xl px-3.5 py-3",
          )}
        >
          <div className={cn("flex min-w-0 items-start gap-2.5", compact ? "" : "flex-1")}>
            <span className="dot dot-danger mt-1" aria-hidden />
            <div className="min-w-0 text-1xs">
              <p className="m-0 leading-relaxed break-words text-ink-soft">{card.text}</p>
              {compact ? null : (
                // 送信内容はデスクトップだけ補助行で示す (compact はボタンのラベルが兼ねる)
                <p className="m-0 mt-1 text-2xs leading-relaxed break-words text-ink-ghost">{RUN_RETRY_NOTE}</p>
              )}
            </div>
          </div>
          <ReloadButton
            onClick={onRetry}
            disabled={retryDisabled}
            aria-describedby={retryBlocked ? reasonId : undefined}
            className={cn(compact && "w-full")}
          >
            {compact ? RUN_RETRY_LABEL_COMPACT : RUN_RETRY_LABEL}
          </ReloadButton>
        </div>
      ) : null}
      <div className="flex min-h-5.25 flex-wrap items-center justify-end gap-x-2 gap-y-0.5 px-1 pb-1.5 text-1xs text-ink-muted">
        {elapsed === null ? null : <RunSpinnerIcon />}
        {showActivity ? (
          // 活動テキストがあるときは下限幅を置き、0 幅まで潰れる前に組を折り返させる
          <span className={cn("flex flex-1 items-baseline gap-1.5", activity ? "min-w-40" : "min-w-0")}>
            <span aria-live="polite" className={cn("min-w-0 break-words", shimmer && "activity-shimmer")}>
              {activity}
            </span>
            {/* 毎秒変わる数字は aria-live の外に置く (読み上げの連発を避ける) */}
            {elapsed === null ? null : (
              <span aria-hidden="true" className="shrink-0 font-sans text-2xs text-ink-ghost tabular-nums">
                ({elapsed})
              </span>
            )}
            {/* 完了の合計時間 (動かない値)。aria-live の外に置き、読み上げの対象には残す */}
            {finishedElapsed === null ? null : (
              <span className="shrink-0 font-sans text-2xs text-ink-ghost tabular-nums">({finishedElapsed})</span>
            )}
          </span>
        ) : null}
        <span className="flex min-w-0 shrink items-center gap-2">
          {modelLabel ? (
            // モデルと Effort は 1 つの単位として読ませる。区切りはモデル名の直後に置き、組の gap より狭くする
            <span className="flex min-w-0 items-center gap-1">
              {/* 読み上げは本文だけで足りるので、provider/id は title (hover) だけに持つ */}
              <span
                title={model ?? modelLabel}
                className={cn("min-w-0 truncate font-sans text-2xs", modelUnavailable ? "text-warn" : "text-ink-faint")}
              >
                {modelLabel}
              </span>
              {effortLabel ? (
                // Effort が無いときは区切りごと出さない (何も無い行にハイフンだけを残さない)
                <span className="shrink-0 font-sans text-2xs whitespace-nowrap text-ink-faint">{`- ${effortLabel}`}</span>
              ) : null}
            </span>
          ) : null}
          {gauge ? (
            <span className={cn("shrink-0 font-sans text-2xs whitespace-nowrap tabular-nums", gaugeColor)}>
              Context
              <span
                role="progressbar"
                aria-label="コンテキスト使用量"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={gauge.fill === null ? undefined : Math.round(gauge.fill * 100)}
                className="mx-1 inline-block h-1.25 w-10 overflow-hidden rounded-full bg-line-strong align-middle"
              >
                {gauge.fill === null || gauge.fill <= 0 ? null : (
                  // 極小の百分率でも「空」と見分けが付くように最小幅を持たせる
                  <span
                    className="block h-full w-(--gauge-fill) min-w-0.5 rounded-full bg-current"
                    style={{ "--gauge-fill": `${gauge.fill * 100}%` } as CSSProperties}
                  />
                )}
              </span>{" "}
              {gauge.percent} <span className="text-ink-ghost">{gauge.detail}</span>
            </span>
          ) : null}
          {onCompact === undefined ? null : (
            <button
              type="button"
              onClick={onCompact}
              disabled={compactDisabled}
              aria-label="会話を圧縮"
              aria-describedby={compactBlocked ? reasonId : undefined}
              className="composer-status-icon"
            >
              <CompactIcon />
            </button>
          )}
        </span>
      </div>
      {blockedNotice === undefined ? null : (
        // 押せない理由を、押した行の真下に 1 行で出す (ボタンは右端なので右寄せにする)
        <p id={reasonId} className="m-0 px-1 pb-1 text-right text-2xs break-words text-ink-ghost">
          {blockedNotice}
        </p>
      )}
    </>
  );
}
