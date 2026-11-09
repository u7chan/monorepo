import type { ReactNode } from "react";
import {
  trialKindLabel,
  trialStateLabel,
  type TrialHistoryRow,
  type TrialMonthGroup,
  type TrialOutcomeFilter,
} from "../../lib/contentTrials";
import { cn } from "../../lib/cn";
import type { ContentTrialSummary } from "../../types";
import { TrashIcon } from "../icons";

/** 成功 / 失敗の絞り込み。中止・中断はどちらにも含めない */
export const TRIAL_OUTCOME_OPTIONS: { value: TrialOutcomeFilter; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "succeeded", label: "成功" },
  { value: "failed", label: "失敗" },
];

/**
 * 履歴の絞り込み。種別は全種別をまとめて出す履歴タブだけが渡す（生成タブは種別が固定）。
 * 保存容量はここではなく一覧の外側が出す（履歴が 0 件でも読めるように）。
 */
export function TrialHistoryFilters({
  kind,
  onChangeKind,
  models,
  modelFilter,
  onChangeModel,
  outcomeFilter,
  onChangeOutcome,
}: {
  /** 種別の絞り込み。省略すると種別の選択を出さない */
  kind?: ContentTrialSummary["kind"] | "all";
  onChangeKind?: (kind: ContentTrialSummary["kind"] | "all") => void;
  /** 履歴に出てきたモデル。省略するとモデルの絞り込みを出さない */
  models?: readonly string[];
  modelFilter?: string;
  onChangeModel?: (model: string) => void;
  outcomeFilter: TrialOutcomeFilter;
  onChangeOutcome: (outcome: TrialOutcomeFilter) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {kind === undefined || onChangeKind === undefined ? null : (
        <label className="flex min-w-0 items-center gap-1">
          <span className="text-2xs text-ink-muted">種別</span>
          <select
            className="field w-auto text-2xs"
            value={kind}
            aria-label="履歴の種別絞り込み"
            onChange={(event) => onChangeKind(event.currentTarget.value as ContentTrialSummary["kind"] | "all")}
          >
            <option value="all">すべて</option>
            <option value="image">画像</option>
            <option value="speech">音声</option>
            <option value="bgm">BGM</option>
          </select>
        </label>
      )}
      {models === undefined || onChangeModel === undefined || modelFilter === undefined ? null : (
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
    </div>
  );
}

/**
 * 履歴の一覧。件数の見出し・[さらに読み込む] / [すべて削除]・月区切り・空の案内・末尾の注記を
 * 1 か所に持ち、履歴タブが行の描画だけを渡す。読み込み済みの行はすべて出し、件数で切らない
 * （一覧は専用の面で、スクロールして読む前提）。
 */
export function TrialHistoryPanel({
  loaded,
  filtered,
  filtering,
  groups,
  hasMore,
  loadingMore,
  busy,
  deletable,
  onLoadMore,
  onDeleteAll,
  renderRow,
}: {
  /** 読み込み済みの件数 */
  loaded: number;
  /** 絞り込み後の件数 */
  filtered: number;
  /** 絞り込みが効いているか（件数が同じでも、絞り込み中なら `n / m` で出す） */
  filtering: boolean;
  groups: readonly TrialMonthGroup[];
  hasMore: boolean;
  loadingMore: boolean;
  busy: boolean;
  /** 削除できる行があるか（実行中以外） */
  deletable: boolean;
  onLoadMore: () => void;
  onDeleteAll: () => void;
  /** 行の描画。面ごとにサムネイル・ボイスが違う */
  renderRow: (trial: ContentTrialSummary) => ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">
          履歴（{filtering ? `${filtered} / ${loaded}` : loaded} 件）
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
 * 履歴の 1 行。状態・種別・モデル・所要時間・キー世代・本文の抜粋を共通に持ち、
 * 左の印だけを種別ごとに受け取る。
 */
export function TrialHistoryRow({
  row,
  selected,
  busy,
  thumbnail,
  voice,
  onSelect,
  onDelete,
}: {
  row: TrialHistoryRow;
  selected: boolean;
  busy: boolean;
  /** 左の印。保存済みの画像だけサムネイルを出し、音声 / BGM は種類の名前を出す */
  thumbnail: { kind: "image"; url: string | null } | { kind: "speech" } | { kind: "bgm" };
  /** 音声のボイス（送信時の値）。画像と BGM の行は省略する */
  voice?: string | null;
  onSelect: () => void;
  onDelete: (id: string) => Promise<boolean>;
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
        aria-label={`${trialKindLabel(row.kind)}の${row.stateLabel}の試行を表示`}
        onClick={onSelect}
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className={cn("text-2xs", row.state === "failed" ? "text-warn" : "text-ink-muted")}>
            {row.stateLabel}
          </span>
          <span className="text-2xs text-ink-muted">{trialKindLabel(row.kind)}</span>
          <code className="min-w-0 truncate text-2xs text-ink-ghost">{row.model}</code>
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
