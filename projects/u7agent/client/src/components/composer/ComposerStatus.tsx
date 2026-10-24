import { useId, type CSSProperties, type ReactNode } from "react";
import { useElapsedMs } from "../../hooks/useElapsedMs";
import { pendingAskUserQuestionCount } from "../../lib/askUser";
import { cn } from "../../lib/cn";
import { elapsedBeatIndex, formatElapsed, isElapsedTier, runElapsedMs } from "../../lib/elapsed";
import { answerWaitQueueReason } from "../../lib/queueWait";
import {
  blockedButtonsNotice,
  retryableRunError,
  RUN_RETRY_LABEL,
  RUN_RETRY_LABEL_SINGLE_COLUMN,
  RUN_RETRY_NOTE,
  type RunErrorInfo,
} from "../../lib/runRetry";
import { contextGauge } from "../../lib/usageFormat";
import type { ContextUsage, RunStatus, ToolCall } from "../../types";
import { CompactIcon, RunSpinnerIcon } from "../icons";
import { ReloadButton } from "../ReloadButton";

/**
 * 入力欄の上の状態行 (活動 / モデル - Effort の入口 / Context ゲージ)。
 * モデル / Effort の入口・ゲージ・圧縮ボタンは 1 つの組にして右端へ寄せ、幅が足りないときだけ組ごと 2 行目へ折り返す
 * (別々に置くと、狭い画面で活動テキストが 1 文字幅まで潰れる。docs/ui-layout.md)。
 * 状態行の中は状態 (活動 / 経過 / モデル / ゲージ) に限り、説明 (待機の理由 / 作用の結果 / 押せない理由) は
 * 下の 1 行へ出す (同じ行に置くと、幅が足りないときに両方が折り返してどちらも行をまたぐ)。
 * 圧縮の不可逆性と課金の注意は、押した時点の確認 (`App` の handleCompact) が担う。
 * 最終失敗の再実行カードは状態行の上に出し、文言は BFF が合成した 1 文をそのまま使う。
 */
export function ComposerStatus({
  activity,
  activityState,
  runningSince,
  runTools = {},
  queueDepth = 0,
  context,
  modelSlot,
  onCompact,
  compactDisabled = false,
  compactDisabledReason,
  singleColumn = false,
  runStatus = "idle",
  runError,
  notice,
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
  /** 回答待ち (ask_user の実行区間) を経過時間から除く入力。run が実行中のときだけ使う */
  runTools?: Record<string, ToolCall>;
  /** サーバーの待機キュー件数 (status payload と同じ値)。回答待ちの理由を出すかの根拠 */
  queueDepth?: number;
  context?: ContextUsage;
  /** モデル / Effort の入口 (ModelEffortPicker)。モデルが未解決でも行を残し、無いときだけ行を出さない */
  modelSlot?: ReactNode;
  /** 手動圧縮。セッションがあるときだけ渡す (未対応ランタイムはサーバーが 501 を返す) */
  onCompact?: () => void;
  compactDisabled?: boolean;
  /** 押せない理由。状態行の下に 1 行で出し、aria-describedby の参照先にもする */
  compactDisabledReason?: string;
  /** 幅の狭いレイアウト。再実行カードのボタンを全幅にする */
  singleColumn?: boolean;
  /** ランがエラーで終わったか。再実行カードの表示条件 (`runStatus === "error"`) に使う */
  runStatus?: RunStatus;
  /** 最後に失敗したランの分類コードと文言。runEnd / resync から保持したもの */
  runError?: RunErrorInfo;
  /**
   * 利用者の操作の結果 (待機の取り消しに失敗した理由など)。活動文言とは別の 1 行として出し、
   * 後から届く status / resync の活動文言に上書きさせない
   */
  notice?: string;
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
  // 実行中の経過。ms と表示文を組で持つ (演出の判定は ms、表示は文)
  let elapsed: { ms: number; text: string } | null = null;
  if (runningSince !== undefined && elapsedMs !== undefined) {
    // 回答待ちを別の now で評価しないのは、tick の値とずれて数字が逆行して見えるため。圧縮中の
    // runningSince はランではないため、前の run のカードは控除しない (runTools は run と同じ寿命)
    const waits = runStatus === "running" ? Object.values(runTools) : [];
    const ms = runElapsedMs({ startedAt: runningSince, at: runningSince + elapsedMs, tools: waits });
    elapsed = { ms, text: formatElapsed(ms) };
  }
  // 演出を先頭から流し直す目印。拍の番号を key に渡し、10 秒ごとに作り直す
  // (桁は毎秒書き換わるが、そのたびに演出を流すと数字より演出が大きくなる)
  const beat = elapsed === null ? 0 : elapsedBeatIndex(elapsed.ms);
  // 活動が無いときは活動欄ごと出さない (空の欄が折り返して空行が残るのを避ける)。回答待ちの理由は
  // 出どころが別 (キュー) なので、活動の文言が変わっても表示を落とさない
  const queueReason = answerWaitQueueReason(pendingAskUserQuestionCount(runTools, runStatus), queueDepth);
  const showActivity = activity !== "" || elapsed !== null || queueReason !== undefined;
  // 再実行カードは時間をおけば回復し得る失敗だけに出す (停止・成功・キュー待ちでは出さない)
  const card = retryableRunError(runStatus, runError);
  const showRetry = card !== undefined && onRetry !== undefined;
  // カードだけの状態でも描画する (activity は空にして文言をカードへ移す)
  if (!showActivity && notice === undefined && !gauge && !modelSlot && onCompact === undefined && !showRetry)
    return null;
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
            singleColumn ? "flex-col gap-2 rounded-lg px-2.5 py-2" : "items-center gap-2.5 rounded-xl px-3.5 py-3",
          )}
        >
          <div className={cn("flex min-w-0 items-start gap-2.5", singleColumn ? "" : "flex-1")}>
            <span className="dot dot-danger mt-1" aria-hidden />
            <div className="min-w-0 text-1xs">
              <p className="m-0 leading-relaxed break-words text-ink-soft">{card.text}</p>
              {singleColumn ? null : (
                // 送信内容はデスクトップだけ補助行で示す (singleColumn はボタンのラベルが兼ねる)
                <p className="m-0 mt-1 text-2xs leading-relaxed break-words text-ink-ghost">{RUN_RETRY_NOTE}</p>
              )}
            </div>
          </div>
          <ReloadButton
            onClick={onRetry}
            disabled={retryDisabled}
            aria-describedby={retryBlocked ? reasonId : undefined}
            className={cn(singleColumn && "w-full")}
          >
            {singleColumn ? RUN_RETRY_LABEL_SINGLE_COLUMN : RUN_RETRY_LABEL}
          </ReloadButton>
        </div>
      ) : null}
      <div className="flex min-h-5.25 flex-wrap items-center justify-end gap-x-2 gap-y-0.5 px-1 pb-1.5 text-1xs text-ink-muted">
        {elapsed === null ? null : <RunSpinnerIcon tone="focus" />}
        {showActivity ? (
          // 活動テキストがあるときは下限幅を置き、0 幅まで潰れる前に組を折り返させる
          <span className={cn("flex flex-1 items-baseline gap-1.5", activity ? "min-w-40" : "min-w-0")}>
            <span aria-live="polite" className={cn("min-w-0 break-words", shimmer && "activity-shimmer")}>
              {activity}
            </span>
            {/* 毎秒変わる数字は aria-live の外に置く (読み上げの連発を避ける) */}
            {elapsed === null ? null : (
              // key に拍の番号を渡し、10 秒ごとに作り直して演出を先頭から流す。数字は同じ要素の
              // テキストを書き換えるだけなので、桁が変わっても演出は再スタートしない
              <span
                key={beat}
                aria-hidden="true"
                className={cn(
                  "elapsed-beat shrink-0 font-sans text-2xs tabular-nums",
                  isElapsedTier(elapsed.ms) ? "elapsed-beat-tier" : "",
                )}
              >
                (実行 {elapsed.text})
              </span>
            )}
          </span>
        ) : null}
        <div className="flex min-w-0 shrink items-center gap-2">
          {modelSlot}
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
        </div>
      </div>
      {queueReason === undefined && blockedNotice === undefined && notice === undefined ? null : (
        // 説明 (待機の理由 / 作用の結果 / 押せない理由) の 1 行。待機の理由を活動と同じ行に置くと、
        // 幅が足りないときに両方が折り返すため、状態行の外へ出す。作用の結果だけは自分の live region で
        // 読み上げる (活動行の aria-live は次の status で別の文言に変わる)
        <div className="flex flex-wrap items-baseline justify-end gap-x-2 px-1 pb-1 text-right text-2xs text-ink-ghost">
          {notice === undefined ? null : (
            <p role="status" className="m-0 min-w-0 break-words text-warn">
              {notice}
            </p>
          )}
          {queueReason === undefined ? null : <p className="m-0 min-w-0 break-words">{queueReason}</p>}
          {blockedNotice === undefined ? null : (
            // aria-describedby (圧縮ボタン) の参照先は押せない理由だけに残す
            <p id={reasonId} className="m-0 min-w-0 break-words">
              {blockedNotice}
            </p>
          )}
        </div>
      )}
    </>
  );
}
