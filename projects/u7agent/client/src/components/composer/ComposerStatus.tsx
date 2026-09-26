import { useId, useState, type CSSProperties } from "react";
import { useElapsedMs } from "../../hooks/useElapsedMs";
import { cn } from "../../lib/cn";
import { formatElapsed } from "../../lib/elapsed";
import { contextGauge } from "../../lib/usageFormat";
import type { ContextUsage } from "../../types";
import { CompactIcon, InfoIcon, RunSpinnerIcon } from "../icons";

/** 圧縮の注意書き。押す前の不可逆性と課金を、hover に頼らず読める形で出す */
const COMPACT_NOTE = "元のメッセージは GUI から戻せません。要約の生成にモデルの利用料金がかかります。";

/**
 * 入力欄の上の状態行 (活動 / モデル / Context ゲージ)。
 * モデル名とゲージは 1 つの組にして右端へ寄せ、幅が足りないときだけ組ごと 2 行目へ折り返す
 * (別々に置くと、狭い画面で活動テキストが 1 文字幅まで潰れる。docs/ui-layout.md)。
 */
export function ComposerStatus({
  activity,
  runningSince,
  context,
  model,
  modelLabel,
  modelUnavailable = false,
  onCompact,
  compactDisabled = false,
  compactDisabledReason,
}: {
  activity: string;
  /** 実行中 / 圧縮中だけ渡す (活動行の経過時間の起点) */
  runningSince?: number;
  context?: ContextUsage;
  /** 実効モデルの provider/id。tooltip と折り返し後の切り詰めの確認に使う */
  model?: string;
  /** 状態行に出す表示名。未作成チャットでは「これから使うモデル」になる */
  modelLabel?: string;
  /** 実効モデルが候補に無い (settings.modelWarning がある) とき true */
  modelUnavailable?: boolean;
  /** 手動圧縮。セッションがあるときだけ渡す (未対応ランタイムはサーバーが 501 を返す) */
  onCompact?: () => void;
  compactDisabled?: boolean;
  /** 押せない理由。note と同じ段落に載せ、aria-describedby でも読ませる */
  compactDisabledReason?: string;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const noteId = useId();
  const gauge = contextGauge(context);
  const elapsedMs = useElapsedMs(runningSince);
  const elapsed = elapsedMs === undefined ? null : formatElapsed(elapsedMs);
  // 活動が無いときは活動欄ごと出さない (空の欄が折り返して空行が残るのを避ける)
  const showActivity = activity !== "" || elapsed !== null;
  if (!showActivity && !gauge && !modelLabel && onCompact === undefined) return null;
  const gaugeColor =
    gauge?.level === "danger" ? "text-danger-text" : gauge?.level === "warn" ? "text-warn" : "text-ink-faint";
  const note = compactDisabled && compactDisabledReason ? `${COMPACT_NOTE}（${compactDisabledReason}）` : COMPACT_NOTE;

  return (
    <>
      <div className="flex min-h-5.25 flex-wrap items-center justify-end gap-x-2 gap-y-0.5 px-1 pb-1.5 text-1xs text-ink-muted">
        {elapsed === null ? null : <RunSpinnerIcon />}
        {showActivity ? (
          // 活動テキストがあるときは下限幅を置き、0 幅まで潰れる前に組を折り返させる
          <span className={cn("flex flex-1 items-baseline gap-1.5", activity ? "min-w-40" : "min-w-0")}>
            <span aria-live="polite" className="min-w-0 break-words">
              {activity}
            </span>
            {/* 毎秒変わる数字は aria-live の外に置く (読み上げの連発を避ける) */}
            {elapsed === null ? null : (
              <span aria-hidden="true" className="shrink-0 font-sans text-2xs text-ink-ghost tabular-nums">
                ({elapsed})
              </span>
            )}
          </span>
        ) : null}
        <span className="flex min-w-0 shrink items-center gap-2">
          {modelLabel ? (
            // 読み上げは本文だけで足りるので、provider/id は title (hover) だけに持つ
            <span
              title={model ?? modelLabel}
              className={cn("min-w-0 truncate font-sans text-2xs", modelUnavailable ? "text-warn" : "text-ink-faint")}
            >
              {modelLabel}
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
            <span className="flex shrink-0 items-center">
              <button
                type="button"
                onClick={onCompact}
                disabled={compactDisabled}
                aria-label="会話を圧縮"
                aria-describedby={noteId}
                title="会話を圧縮（元のメッセージには戻せません）"
                className="composer-status-icon"
              >
                <CompactIcon />
              </button>
              {/* 注意書きは hover に頼らずタップで開ける (読み上げには describedby で常に渡す) */}
              <button
                type="button"
                onClick={() => setNoteOpen((open) => !open)}
                aria-expanded={noteOpen}
                aria-label="圧縮の注意"
                className="composer-status-icon"
              >
                <InfoIcon />
              </button>
            </span>
          )}
        </span>
      </div>
      {onCompact === undefined ? null : (
        <p id={noteId} className={cn("m-0 px-1 pb-1 text-2xs break-words text-ink-ghost", noteOpen ? "" : "sr-only")}>
          {note}
        </p>
      )}
    </>
  );
}
