import { useState } from "react";
import {
  BGM_TRIAL_PROMPT_MAX_LENGTH,
  bgmDurationLabel,
  bgmTrialInput,
  filteredTrials,
  groupTrialsByMonth,
  hasStoredArtifact,
  selectedTrial,
  trialArtifactUrl,
  trialByteSizeLabel,
  trialHistoryRow,
  trialPanelState,
  trialStartBlockedReason,
  trialStateLabel,
  type TrialHistoryRow,
  type TrialOutcomeFilter,
} from "../../lib/contentTrials";
import { cn } from "../../lib/cn";
import type {
  ContentSettingsResponse,
  ContentTrial,
  ContentTrialArtifactUsageValue,
  CreateContentTrialBody,
} from "../../types";
import { CheckIcon, TrashIcon } from "../icons";

/** 履歴の既定表示件数。全件は「すべて見る」で開く（時間ベースの自動削除はしない） */
const HISTORY_PREVIEW_COUNT = 3;

/** 成功 / 失敗の絞り込み。中止・中断はどちらにも含めない */
const OUTCOME_OPTIONS: { value: TrialOutcomeFilter; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "succeeded", label: "成功" },
  { value: "failed", label: "失敗" },
];

export type BgmTrialSectionProps = {
  settings: ContentSettingsResponse;
  /** 固定モデル。未設定では空文字（開始は `trialStartBlockedReason` が止める） */
  model: string;
  trials: readonly ContentTrial[] | null;
  keyEpoch: number;
  artifactUsage: ContentTrialArtifactUsageValue;
  note: { text: string; error: boolean } | null;
  busy: boolean;
  /** プロンプトの下書き。面を切り替えても失わないよう、呼び出し側が持つ */
  prompt: string;
  onChangePrompt: (prompt: string) => void;
  onStart: (input: CreateContentTrialBody) => Promise<boolean>;
  onCancel: (id: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onDeleteAll: () => Promise<boolean>;
};

/**
 * 設定に反映しない BGM の試行。モデルは固定なので選択肢を持たず、履歴はプロンプト履歴になる。
 * 入力はプロンプトだけ（尺 / BPM / ループは非ゴール）で、結果は 1 つの再生ビューポート + 履歴セレクタ。
 */
export function BgmTrialSection({
  settings,
  model,
  trials,
  keyEpoch,
  artifactUsage,
  note,
  busy,
  prompt,
  onChangePrompt,
  onStart,
  onCancel,
  onDelete,
  onDeleteAll,
}: BgmTrialSectionProps) {
  const [showAll, setShowAll] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [outcomeFilter, setOutcomeFilter] = useState<TrialOutcomeFilter>("all");
  const [inputError, setInputError] = useState<string | null>(null);
  // 一覧は全種別を 1 回で取るため、この面は BGM の試行だけを出す
  const list = (trials ?? []).filter((trial) => trial.kind === "bgm");
  const panel = trialPanelState({
    runtimeAvailable: settings.runtimeAvailable,
    configured: settings.configured,
    enabled: settings.enabled,
    synced: true,
    trials: list,
  });
  const running = list.find((trial) => trial.state === "running") ?? null;
  const selected = selectedTrial({ trials: list, selectedId });
  const blocked = trialStartBlockedReason({
    runtimeAvailable: settings.runtimeAvailable,
    configured: settings.configured,
    enabled: settings.enabled,
    keyAvailable: settings.keyAvailable,
    running: running !== null,
    prompt,
    emptyPromptReason: "BGM のプロンプトを入力してください",
  });
  const filtered = filteredTrials({ trials: list, model: "all", outcome: outcomeFilter });
  const visible = showAll ? filtered : filtered.slice(0, HISTORY_PREVIEW_COUNT);
  const groups = groupTrialsByMonth(visible);

  const start = (value: string, nextModel: string, force = false) => {
    const request = bgmTrialInput(value, nextModel);
    if (!request.ok) {
      setInputError(request.error);
      return;
    }
    setInputError(null);
    void onStart({ ...request.input, ...(force ? { force: true } : {}) });
  };

  return (
    <section className="grid min-w-0 gap-2 border-t border-line pt-3">
      <div className="grid gap-0.5">
        <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">設定に反映しない試行</h3>
        <p className="text-2xs leading-relaxed text-ink-muted">
          固定モデルで生成だけを試します。保存する設定はありません。送ったプロンプトと結果はアプリのデータ領域に
          履歴として残ります（時間ベースでは消えません）。
        </p>
      </div>

      <label className="grid min-w-0 gap-1">
        <span className="text-2xs text-ink-muted">プロンプト（履歴に保存されます）</span>
        <textarea
          className="field min-h-16 min-w-0 resize-y text-xs"
          value={prompt}
          placeholder="つくりたいBGMを書いてください（例: 夜の高速道路を走る軽快なシンセポップ）"
          aria-label="試行のプロンプト"
          maxLength={BGM_TRIAL_PROMPT_MAX_LENGTH}
          spellCheck={false}
          disabled={busy}
          onChange={(event) => onChangePrompt(event.currentTarget.value)}
        />
      </label>
      <p className="text-2xs leading-relaxed text-ink-faint">
        インストゥルメンタル（ボーカルなし）で生成します。尺・BPM・ループの指定はできず、
        <span className="text-ink-soft">ボーカルが入らないこと・正確なBPMや尺・シームレスループは保証しません</span>
        。失敗や中断でも課金される可能性があるため、自動では再生成しません。
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || blocked !== null}
          onClick={() => start(prompt, model)}
        >
          <CheckIcon />
          {running ? "生成中…" : "試行する"}
        </button>
        {running ? (
          <button type="button" className="btn-quiet" disabled={busy} onClick={() => void onCancel(running.id)}>
            中断
          </button>
        ) : null}
        <p role="status" className="min-w-0 text-2xs text-ink-muted">
          {panelNote(panel)}
          {blocked === null ? null : <span className="text-ink-faint">（{blocked}）</span>}
        </p>
      </div>

      {/* 送信前の検証と試行の操作の結果は、この面の中だけに出す（設定の注記と場所を奪い合わない） */}
      {inputError ? (
        <p role="alert" className="text-2xs break-words text-warn">
          {inputError}
        </p>
      ) : null}
      {note ? (
        <p role="status" className={cn("text-2xs break-words", note.error ? "text-warn" : "text-ink-muted")}>
          {note.text}
        </p>
      ) : null}

      {selected ? (
        <ResultViewport
          // 実測の尺は選んだ試行ごとに読み直す（前の行の秒数を残さない）
          key={selected.id}
          trial={selected}
          currentKeyEpoch={keyEpoch}
          busy={busy}
          running={running !== null}
          expectedDurationSeconds={settings.bgm.expectedDurationSeconds}
          onDelete={onDelete}
          onRestore={() => {
            setInputError(null);
            onChangePrompt(selected.prompt);
          }}
          onAnotherTake={() => start(selected.prompt, model, true)}
        />
      ) : (
        <p className="text-2xs text-ink-faint">まだ試行の履歴はありません。</p>
      )}

      {list.length === 0 ? null : (
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">
              履歴（{outcomeFilter === "all" ? list.length : `${filtered.length} / ${list.length}`} 件）
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {filtered.length > HISTORY_PREVIEW_COUNT || showAll ? (
                <button type="button" className="btn-quiet" onClick={() => setShowAll((current) => !current)}>
                  {showAll ? "最新 3 件だけ表示" : "すべて見る"}
                </button>
              ) : null}
              <button
                type="button"
                className="btn-quiet"
                disabled={busy || !list.some((trial) => trial.state !== "running")}
                onClick={() => void onDeleteAll()}
              >
                <TrashIcon />
                すべて削除
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex min-w-0 items-center gap-1">
              <span className="text-2xs text-ink-muted">結果</span>
              <select
                className="field w-auto text-2xs"
                value={outcomeFilter}
                aria-label="履歴の成功失敗の絞り込み"
                onChange={(event) => setOutcomeFilter(event.currentTarget.value as TrialOutcomeFilter)}
              >
                {OUTCOME_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-2xs text-ink-faint">
              保存容量: {artifactUsage.count} 件 · {trialByteSizeLabel(artifactUsage.bytes)}（画像・音声と共通）
            </span>
          </div>

          {filtered.length === 0 ? (
            <p className="text-2xs text-ink-faint">条件に合う履歴はありません。</p>
          ) : (
            <div className="grid gap-1">
              {groups.map((group) => (
                <div key={group.key} className="grid gap-1">
                  <div className="text-2xs text-ink-faint">{group.label}</div>
                  <ul className="grid gap-1">
                    {group.trials.map((trial) => (
                      <HistoryListItem
                        key={trial.id}
                        row={trialHistoryRow(trial, keyEpoch)}
                        selected={trial.id === selected?.id}
                        busy={busy}
                        onSelect={() => setSelectedId(trial.id)}
                        onRetry={() => start(trial.prompt, model)}
                        onDelete={onDelete}
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
          <p className="text-2xs leading-relaxed text-ink-faint">
            履歴は自動では消えません。実行中の試行は削除できません（先に中断してください）。
          </p>
        </div>
      )}
    </section>
  );
}

/** 状態ごとの 1 行。主ボタンの理由は `trialStartBlockedReason` が持つので、ここは状態だけを出す */
function panelNote(panel: ReturnType<typeof trialPanelState>): string {
  switch (panel) {
    case "runtime_unavailable":
      return "ランタイムが利用できないため試行できません。";
    case "unconfigured":
      return "APIキーが未設定です。履歴だけを表示しています。";
    case "disabled":
      return "全体が OFF です。履歴は残り、新規の生成だけを止めています。";
    case "unsynced":
      return "音声の設定を確認できていません。試行はできます。";
    case "empty":
      return "まだ試行していません。";
    case "running":
      return "生成中です。画面を離れても続きます。";
    case "failed":
      return "直近の試行は失敗しました。";
    case "interrupted":
      return "前回の試行はサーバーの再起動で中断されました。";
    case "ready":
      return "前回の試行は完了しています。";
  }
}

/**
 * 1 つの再生ビューポート。表示中の試行のスナップショットだけを出し、下書きのプロンプトとは混ぜない。
 * 実測の尺は `<audio>` のメタデータから読み、読めるまでは `—` にする（目安尺と混ぜない）。
 */
function ResultViewport({
  trial,
  currentKeyEpoch,
  busy,
  running,
  expectedDurationSeconds,
  onDelete,
  onRestore,
  onAnotherTake,
}: {
  trial: ContentTrial;
  currentKeyEpoch: number;
  busy: boolean;
  running: boolean;
  expectedDurationSeconds: number;
  onDelete: (id: string) => Promise<boolean>;
  onRestore: () => void;
  onAnotherTake: () => void;
}) {
  const [measured, setMeasured] = useState<number | null>(null);
  const row = trialHistoryRow(trial, currentKeyEpoch);
  const stored = hasStoredArtifact(trial);

  return (
    <div className="grid gap-2 rounded-lg border border-line bg-soft p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs font-semibold text-ink-strong">結果</span>
        <span className={cn("text-2xs", trial.state === "failed" ? "text-warn" : "text-ink-muted")}>
          {row.stateLabel}
        </span>
        <code className="text-2xs text-ink-ghost">{row.model}</code>
        <span className="text-2xs text-ink-muted">{row.durationLabel}</span>
        {row.keyEpochLabel ? <span className="text-2xs text-warn">{row.keyEpochLabel}</span> : null}
        {trial.recorded ? null : <span className="text-2xs text-warn">状態を記録できませんでした</span>}
      </div>

      {stored ? (
        <div className="grid gap-1">
          {/* 実測の尺は再生可能なバイト列でしか読めないため、プレイヤーのメタデータから取る */}
          <audio
            controls
            src={trialArtifactUrl(trial.id)}
            aria-label="試行のBGM"
            className="w-full"
            onLoadedMetadata={(event) => setMeasured(event.currentTarget.duration)}
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-2xs text-ink-muted">{row.artifactLabel}</span>
            <a className="btn-quiet" href={trialArtifactUrl(trial.id, { download: true })}>
              ダウンロード
            </a>
          </div>
          <p className="text-2xs text-ink-faint">
            モデル仕様の目安: {expectedDurationSeconds} 秒 · 実測: {bgmDurationLabel(measured)}
          </p>
        </div>
      ) : trial.state === "running" ? (
        <p className="text-2xs text-ink-muted" role="status">
          生成中です。送信したプロンプトを表示しています（入力欄の編集とは別です）。
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

      <p className="text-2xs break-words whitespace-pre-wrap text-ink">{row.prompt}</p>

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
      <p className="text-2xs leading-relaxed text-ink-faint">別のテイクは新しい試行として課金されます。</p>
    </div>
  );
}

function HistoryListItem({
  row,
  selected,
  busy,
  onSelect,
  onRetry,
  onDelete,
}: {
  row: TrialHistoryRow;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onRetry: () => void;
  onDelete: (id: string) => Promise<boolean>;
}) {
  return (
    <li
      className={cn(
        "flex min-w-0 items-center gap-2 rounded border px-2 py-1.5",
        selected ? "border-accent/60 bg-raised" : "border-line bg-base",
      )}
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded border border-line text-2xs text-ink-ghost">
        BGM
      </span>
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
          <span className="text-2xs text-ink-muted">{row.durationLabel}</span>
          {row.keyEpochLabel ? <span className="text-2xs text-warn">{row.keyEpochLabel}</span> : null}
        </span>
        <span className="min-w-0 truncate text-2xs text-ink" title={row.prompt}>
          {row.prompt}
        </span>
        {row.artifactLabel ? <span className="text-2xs text-ink-faint">{row.artifactLabel}</span> : null}
        {row.failureLabel ? <span className="text-2xs text-warn">{row.failureLabel}</span> : null}
      </button>
      {/* 同じプロンプトをもう一度試す。保存済みの結果があれば再利用され、課金されない */}
      <button
        type="button"
        className="btn-quiet shrink-0"
        disabled={busy || row.state === "running"}
        aria-label={`${trialStateLabel(row.state)}の試行をもう一度試す`}
        onClick={onRetry}
      >
        もう一度試す
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
