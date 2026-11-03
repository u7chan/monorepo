import type { ReactNode } from "react";
import {
  trialStateLabel,
  trialStorageNote,
  type TrialHistoryRow,
  type TrialMonthGroup,
  type TrialOutcomeFilter,
} from "../../lib/contentTrials";
import { cn } from "../../lib/cn";
import type { ContentTrialArtifactUsageValue, ContentTrialSummary } from "../../types";
import { TrashIcon } from "../icons";

/** 履歴の既定表示件数。全件は「すべて見る」で開く（時間ベースの自動削除はしない） */
export const TRIAL_HISTORY_PREVIEW_COUNT = 3;

/** 成功 / 失敗の絞り込み。中止・中断はどちらにも含めない */
export const TRIAL_OUTCOME_OPTIONS: { value: TrialOutcomeFilter; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "succeeded", label: "成功" },
  { value: "failed", label: "失敗" },
];

/**
 * 履歴の絞り込みと保存容量。モデルの絞り込みは固定モデルの面（BGM）では渡さない。
 * 容量は 3 タブの合計なので、どの面でも同じ 1 行を出す。
 */
export function TrialHistoryFilters({
  models,
  modelFilter,
  onChangeModel,
  outcomeFilter,
  onChangeOutcome,
  artifactUsage,
}: {
  /** 履歴に出てきたモデル。固定モデルの面は省略する */
  models?: readonly string[];
  modelFilter?: string;
  onChangeModel?: (model: string) => void;
  outcomeFilter: TrialOutcomeFilter;
  onChangeOutcome: (outcome: TrialOutcomeFilter) => void;
  artifactUsage: ContentTrialArtifactUsageValue;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {models === undefined || onChangeModel === undefined ? null : (
        <label className="flex min-w-0 items-center gap-1">
          <span className="text-2xs text-ink-muted">モデル</span>
          <select
            className="field w-auto max-w-56 text-2xs"
            value={modelFilter}
            aria-label="履歴のモデル絞り込み"
            onChange={(event) => onChangeModel(event.currentTarget.value)}
          >
            <option value="all">すべて</option>
            {models.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex min-w-0 items-center gap-1">
        <span className="text-2xs text-ink-muted">結果</span>
        <select
          className="field w-auto text-2xs"
          value={outcomeFilter}
          aria-label="履歴の成功失敗の絞り込み"
          onChange={(event) => onChangeOutcome(event.currentTarget.value as TrialOutcomeFilter)}
        >
          {TRIAL_OUTCOME_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <span className="text-2xs text-ink-faint">{trialStorageNote(artifactUsage)}</span>
    </div>
  );
}

/**
 * 履歴の一覧。件数の見出し・[すべて見る] / [さらに読み込む] / [すべて削除]・月区切り・
 * 空の案内・末尾の注記を 1 か所に持ち、面ごとに違うのは行の描画だけにする。
 */
export function TrialHistoryPanel({
  loaded,
  filtered,
  filtering,
  groups,
  showAll,
  hasMore,
  loadingMore,
  busy,
  deletable,
  filters,
  onToggleShowAll,
  onLoadMore,
  onDeleteAll,
  renderRow,
}: {
  /** 種類で絞った読み込み済みの件数 */
  loaded: number;
  /** 絞り込み後の件数 */
  filtered: number;
  /** 絞り込みが効いているか（件数が同じでも、絞り込み中なら `n / m` で出す） */
  filtering: boolean;
  groups: readonly TrialMonthGroup[];
  showAll: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  busy: boolean;
  /** 削除できる行があるか（実行中以外） */
  deletable: boolean;
  /** 絞り込みの入力（`TrialHistoryFilters`） */
  filters: ReactNode;
  onToggleShowAll: () => void;
  onLoadMore: () => void;
  onDeleteAll: () => void;
  /** 行の描画。面ごとにサムネイル・ボイス・再実行の導線が違う */
  renderRow: (trial: ContentTrialSummary) => ReactNode;
}) {
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">
          履歴（{filtering ? `${filtered} / ${loaded}` : loaded} 件）
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {filtered > TRIAL_HISTORY_PREVIEW_COUNT || showAll ? (
            <button type="button" className="btn-quiet" onClick={onToggleShowAll}>
              {showAll ? "最新 3 件だけ表示" : "すべて見る"}
            </button>
          ) : null}
          {hasMore ? (
            <button type="button" className="btn-quiet" disabled={loadingMore} onClick={onLoadMore}>
              {loadingMore ? "読み込み中…" : "さらに読み込む"}
            </button>
          ) : null}
          <button type="button" className="btn-quiet" disabled={busy || !deletable} onClick={onDeleteAll}>
            <TrashIcon />
            すべて削除
          </button>
        </div>
      </div>

      {filters}

      {filtered === 0 ? (
        <p className="text-2xs text-ink-faint">条件に合う履歴はありません。</p>
      ) : (
        <div className="grid gap-1">
          {groups.map((group) => (
            <div key={group.key} className="grid gap-1">
              <div className="text-2xs text-ink-faint">{group.label}</div>
              <ul className="grid gap-1">{group.trials.map((trial) => renderRow(trial))}</ul>
            </div>
          ))}
        </div>
      )}
      <p className="text-2xs leading-relaxed text-ink-faint">
        履歴は自動では消えません。実行中の試行は削除できません（先に中断してください）。
      </p>
    </div>
  );
}

/**
 * 履歴の 1 行。状態・モデル・所要時間・キー世代・本文の抜粋を共通に持ち、左の印と
 * 音声のボイス・再実行の導線だけを面ごとに受け取る。
 */
export function TrialHistoryRow({
  row,
  selected,
  busy,
  thumbnail,
  voice,
  showModel = true,
  onSelect,
  onDelete,
  onRetry,
}: {
  row: TrialHistoryRow;
  selected: boolean;
  busy: boolean;
  /** 左の印。保存済みの画像だけサムネイルを出し、音声 / BGM は種類の名前を出す */
  thumbnail: { kind: "image"; url: string | null } | { kind: "speech" } | { kind: "bgm" };
  /** 音声のボイス（送信時の値）。画像と BGM の行は省略する */
  voice?: string | null;
  /** 固定モデルの面（BGM）は行にモデルを出さない */
  showModel?: boolean;
  onSelect: () => void;
  onDelete: (id: string) => Promise<boolean>;
  /** 「もう一度試す」を出す面だけ渡す */
  onRetry?: () => void;
}) {
  return (
    <li
      className={cn(
        "flex min-w-0 items-center gap-2 rounded border px-2 py-1.5",
        selected ? "border-accent/60 bg-raised" : "border-line bg-base",
      )}
    >
      {thumbnail.kind === "image" && thumbnail.url !== null ? (
        <img src={thumbnail.url} alt="" loading="lazy" className="h-10 w-10 shrink-0 rounded object-cover" />
      ) : (
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded border border-line text-2xs text-ink-ghost">
          {thumbnail.kind === "image" ? "記録" : thumbnail.kind === "speech" ? "音声" : "BGM"}
        </span>
      )}
      <button
        type="button"
        className="grid min-w-0 flex-1 gap-0.5 text-left"
        aria-pressed={selected}
        aria-label={`${row.stateLabel}の試行を表示`}
        onClick={onSelect}
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className={cn("text-2xs", row.state === "failed" ? "text-warn" : "text-ink-muted")}>
            {row.stateLabel}
          </span>
          {showModel ? <code className="min-w-0 truncate text-2xs text-ink-ghost">{row.model}</code> : null}
          {voice === null || voice === undefined ? null : (
            <span className="text-2xs text-ink-muted">ボイス: {voice}</span>
          )}
          <span className="text-2xs text-ink-muted">{row.durationLabel}</span>
          {row.keyEpochLabel ? <span className="text-2xs text-warn">{row.keyEpochLabel}</span> : null}
        </span>
        <span className="min-w-0 truncate text-2xs text-ink" title={row.promptPreview}>
          {row.promptPreview}
        </span>
        {row.artifactLabel ? <span className="text-2xs text-ink-faint">{row.artifactLabel}</span> : null}
        {row.failureLabel ? <span className="text-2xs text-warn">{row.failureLabel}</span> : null}
      </button>
      {onRetry === undefined ? null : (
        <button
          type="button"
          className="btn-quiet shrink-0"
          disabled={busy || row.state === "running"}
          aria-label={`${trialStateLabel(row.state)}の試行をもう一度試す`}
          onClick={onRetry}
        >
          もう一度試す
        </button>
      )}
      <button
        type="button"
        className="btn-quiet shrink-0"
        disabled={busy || row.state === "running"}
        aria-label={`${trialStateLabel(row.state)}の試行を削除`}
        onClick={() => void onDelete(row.id)}
      >
        <TrashIcon />
      </button>
    </li>
  );
}
