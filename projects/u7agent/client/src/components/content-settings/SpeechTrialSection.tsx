import { useState } from "react";
import {
  filteredTrials,
  groupTrialsByMonth,
  hasStoredArtifact,
  selectedTrial,
  speechTrialDraftOf,
  speechTrialRequest,
  speechTrialSnapshotLabels,
  trialArtifactUrl,
  trialByteSizeLabel,
  trialHistoryRow,
  trialModelOptions,
  trialPanelState,
  trialStartBlockedReason,
  trialStateLabel,
  type SpeechTrialDraft,
  type TrialHistoryRow,
  type TrialOutcomeFilter,
  type TrialRequestOrigin,
} from "../../lib/contentTrials";
import { SPEECH_SPEED_MIN, SPEECH_SPEED_STEP, speechSpeedStep } from "../../lib/contentSettings";
import { cn } from "../../lib/cn";
import { speechTrialDefaultTarget } from "../../lib/trialDefault";
import type {
  ContentSettingsResponse,
  ContentTrial,
  ContentTrialArtifactUsageValue,
  CreateContentTrialBody,
  UpdateContentSpeechBody,
} from "../../types";
import { CheckIcon, MinusIcon, PlusIcon, TrashIcon } from "../icons";
import { TrialDefaultAction, UNCONFIGURED_BLOCKED_NOTE } from "./TrialDefaultAction";

/** 履歴の既定表示件数。全件は「すべて見る」で開く（時間ベースの自動削除はしない） */
const HISTORY_PREVIEW_COUNT = 3;

/** 成功 / 失敗の絞り込み。中止・中断はどちらにも含めない */
const OUTCOME_OPTIONS: { value: TrialOutcomeFilter; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "succeeded", label: "成功" },
  { value: "failed", label: "失敗" },
];

/**
 * 未同期の間、結果カードから既定へ保存できない理由。同じ `PUT /speech` を呼ぶ保存フォームが止まるのと
 * 同じ状態を指す（短く書く）。
 */
const SYNC_BLOCKED_NOTE = "サーバーの現在の設定を確認できていないため、再読み込みするまで保存できません。";

export type SpeechTrialSectionProps = {
  settings: ContentSettingsResponse;
  /** 画面で選択中のモデル（下書き優先）。保存前でも画面の値で試行する */
  model: string;
  /** 画面で選択中のボイス。モデルの宣言に応じた値（空文字は「指定なし」） */
  voice: string;
  trials: readonly ContentTrial[] | null;
  keyEpoch: number;
  artifactUsage: ContentTrialArtifactUsageValue;
  note: { text: string; error: boolean } | null;
  busy: boolean;
  /** 設定の保存中。既定の保存を重ねない（試行の `busy` とは別の軸） */
  settingsBusy: boolean;
  /** サーバーの現在値を確認できているか。false の間は保存フォームと同じく既定の保存も止める */
  synced: boolean;
  /** 試行のモデルとボイスを既定として保存する。成功したら呼び出し側が下書きを捨てる */
  onMakeDefault: (input: UpdateContentSpeechBody) => Promise<boolean>;
  /** 本文・演技指示・話速の下書き。面を切り替えても失わないよう、呼び出し側が持つ */
  draft: SpeechTrialDraft;
  onChangeDraft: (draft: SpeechTrialDraft) => void;
  onStart: (input: CreateContentTrialBody) => Promise<boolean>;
  onCancel: (id: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onDeleteAll: () => Promise<boolean>;
};

/**
 * 設定に反映しない音声の試行。画像タブと同じく 1 つの再生ビューポート + 履歴セレクタで見せ、
 * 結果は trial id の raw ルートで配信する。本文・演技指示・話速は履歴のスナップショットで、
 * 保存される設定（モデル / ボイス）とは混ぜない。
 */
export function SpeechTrialSection({
  settings,
  model,
  voice,
  trials,
  keyEpoch,
  artifactUsage,
  note,
  busy,
  settingsBusy,
  synced,
  onMakeDefault,
  draft,
  onChangeDraft,
  onStart,
  onCancel,
  onDelete,
  onDeleteAll,
}: SpeechTrialSectionProps) {
  const [showAll, setShowAll] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState("all");
  const [outcomeFilter, setOutcomeFilter] = useState<TrialOutcomeFilter>("all");
  const [inputError, setInputError] = useState<string | null>(null);
  // 一覧は全種別を 1 回で取るため、この面は音声の試行だけを出す
  const list = (trials ?? []).filter((trial) => trial.kind === "speech");
  const panel = trialPanelState({
    runtimeAvailable: settings.runtimeAvailable,
    configured: settings.configured,
    enabled: settings.enabled,
    synced: true,
    trials: list,
  });
  const running = list.find((trial) => trial.state === "running") ?? null;
  const selected = selectedTrial({ trials: list, selectedId });
  // 同じ組み合わせを保存しても何も変わらないため、結果との差分があるときだけ導線を出す
  const defaultTarget = selected
    ? speechTrialDefaultTarget({ settings, trialModel: selected.model, trialVoice: selected.voice })
    : null;
  // 保存フォームと同じゲート。履歴と結果は未設定・未同期でも読めるが、同じ PUT を呼ぶ保存は止める
  const defaultBlockedReason = !settings.configured ? UNCONFIGURED_BLOCKED_NOTE : synced ? null : SYNC_BLOCKED_NOTE;
  const blocked = trialStartBlockedReason({
    runtimeAvailable: settings.runtimeAvailable,
    configured: settings.configured,
    enabled: settings.enabled,
    keyAvailable: settings.keyAvailable,
    running: running !== null,
    prompt: draft.text,
    emptyPromptReason: "本文を入力してください",
  });
  const models = trialModelOptions(list);
  const filtered = filteredTrials({ trials: list, model: modelFilter, outcome: outcomeFilter });
  const visible = showAll ? filtered : filtered.slice(0, HISTORY_PREVIEW_COUNT);
  const groups = groupTrialsByMonth(visible);
  const filtering = modelFilter !== "all" || outcomeFilter !== "all";

  /** 検証を通ったときだけ要求を出し、開始できたかを返す（別テイクの自動選択に使う） */
  const start = async (
    values: SpeechTrialDraft,
    nextModel: string,
    nextVoice: string,
    origin: TrialRequestOrigin,
  ): Promise<boolean> => {
    const request = speechTrialRequest({ draft: values, model: nextModel, voice: nextVoice, origin });
    if (!request.ok) {
      setInputError(request.error);
      return false;
    }
    setInputError(null);
    return onStart(request.input);
  };

  return (
    <section className="grid min-w-0 gap-2 border-t border-line pt-3">
      <div className="grid gap-0.5">
        <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">設定に反映しない試行</h3>
        <p className="text-2xs leading-relaxed text-ink-muted">
          画面の値で生成だけを試します。モデルとボイスの保存値は変えません。送った本文・演技指示・話速と結果は
          アプリのデータ領域に履歴として残ります（時間ベースでは消えません）。
        </p>
      </div>

      <label className="grid min-w-0 gap-1">
        <span className="text-2xs text-ink-muted">読み上げる文章（履歴に保存されます）</span>
        <textarea
          className="field min-h-16 min-w-0 resize-y text-xs"
          value={draft.text}
          placeholder="読み上げる文章（演技指示は下の欄へ）"
          aria-label="試行の本文"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => onChangeDraft({ ...draft, text: event.currentTarget.value })}
        />
      </label>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input
          className="field min-w-0 flex-1 text-xs"
          value={draft.instructions}
          aria-label="試行の演技指示"
          placeholder="演技指示（任意。未対応のモデルでは無視されるか 400 になります）"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => onChangeDraft({ ...draft, instructions: event.currentTarget.value })}
        />
        {/* 空欄は「送らない」（provider の既定）。増減は押下だけで完結させ、欄は手入力も受ける */}
        <div className="flex items-center gap-1">
          <span className="text-2xs text-ink-faint">話速</span>
          <button
            type="button"
            className="icon-button"
            aria-label={`話速を ${SPEECH_SPEED_STEP} 下げる`}
            disabled={busy}
            onClick={() => onChangeDraft({ ...draft, speed: speechSpeedStep(draft.speed, -SPEECH_SPEED_STEP) })}
          >
            <MinusIcon />
          </button>
          <input
            className="field w-16 text-center text-xs"
            value={draft.speed}
            aria-label="試行の話速"
            placeholder="既定"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => onChangeDraft({ ...draft, speed: event.currentTarget.value })}
          />
          <button
            type="button"
            className="icon-button"
            aria-label={`話速を ${SPEECH_SPEED_STEP} 上げる`}
            disabled={busy}
            onClick={() => onChangeDraft({ ...draft, speed: speechSpeedStep(draft.speed, SPEECH_SPEED_STEP) })}
          >
            <PlusIcon />
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-baseline gap-2 text-2xs leading-relaxed text-ink-faint">
        <p>
          話速は <span className="text-ink-soft">1.0 が標準</span>
          （倍率）。0.8 で遅く、1.2 で速く。空欄はモデル既定（下限 {SPEECH_SPEED_MIN}
          ）。対応範囲はモデルにより異なります。
        </p>
        {draft.speed.trim() === "" ? null : (
          <button
            type="button"
            className="text-accent-text underline underline-offset-2 disabled:opacity-45"
            disabled={busy}
            onClick={() => onChangeDraft({ ...draft, speed: "" })}
          >
            既定に戻す
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || blocked !== null}
          onClick={() => void start(draft, model, voice, "form")}
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
          trial={selected}
          currentKeyEpoch={keyEpoch}
          busy={busy}
          running={running !== null}
          defaultTarget={defaultTarget}
          settingsBusy={settingsBusy}
          blockedReason={defaultBlockedReason}
          onMakeDefault={onMakeDefault}
          onDelete={onDelete}
          onRestore={() => {
            setInputError(null);
            onChangeDraft(speechTrialDraftOf(selected));
          }}
          onAnotherTake={async () => {
            // 始めた行をビューポートへ寄せる。開始できなければ選択を動かさない
            const started = await start(
              {
                text: selected.prompt,
                instructions: selected.instructions ?? "",
                speed: selected.speed === null ? "" : String(selected.speed),
              },
              selected.model,
              selected.voice ?? "",
              "another-take",
            );
            if (started) setSelectedId(null);
          }}
        />
      ) : (
        <p className="text-2xs text-ink-faint">まだ試行の履歴はありません。</p>
      )}

      {list.length === 0 ? null : (
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">
              履歴（{filtering ? `${filtered.length} / ${list.length}` : list.length} 件）
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
              <span className="text-2xs text-ink-muted">モデル</span>
              <select
                className="field w-auto max-w-56 text-2xs"
                value={modelFilter}
                aria-label="履歴のモデル絞り込み"
                onChange={(event) => setModelFilter(event.currentTarget.value)}
              >
                <option value="all">すべて</option>
                {models.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
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
              保存容量: {artifactUsage.count} 件 · {trialByteSizeLabel(artifactUsage.bytes)}（画像と共通）
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
 * 1 つの再生ビューポート。表示中の試行のスナップショットだけを出し、下書きとは混ぜない。
 * 再生は共通の raw ルート（trial id だけ）で、形式は保存時に確定した MIME に従う。
 */
function ResultViewport({
  trial,
  currentKeyEpoch,
  busy,
  running,
  defaultTarget,
  settingsBusy,
  blockedReason,
  onMakeDefault,
  onDelete,
  onRestore,
  onAnotherTake,
}: {
  trial: ContentTrial;
  currentKeyEpoch: number;
  busy: boolean;
  running: boolean;
  /** 既定として保存する本文。保存値と同じなら null（導線を出さない） */
  defaultTarget: UpdateContentSpeechBody | null;
  settingsBusy: boolean;
  /** 保存できない理由（キー未設定 / 現在の設定を確認できない）。null なら押せる */
  blockedReason: string | null;
  onMakeDefault: (input: UpdateContentSpeechBody) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onRestore: () => void;
  onAnotherTake: () => void;
}) {
  const row = trialHistoryRow(trial, currentKeyEpoch);
  const stored = hasStoredArtifact(trial);
  const labels = speechTrialSnapshotLabels(trial);

  return (
    <div className="grid gap-2 rounded-lg border border-line bg-soft p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs font-semibold text-ink-strong">結果</span>
        <span className={cn("text-2xs", trial.state === "failed" ? "text-warn" : "text-ink-muted")}>
          {row.stateLabel}
        </span>
        <code className="text-2xs text-ink-ghost">{row.model}</code>
        <span className="text-2xs text-ink-muted">ボイス: {labels.voice}</span>
        <span className="text-2xs text-ink-muted">{row.durationLabel}</span>
        {row.keyEpochLabel ? <span className="text-2xs text-warn">{row.keyEpochLabel}</span> : null}
        {trial.recorded ? null : <span className="text-2xs text-warn">状態を記録できませんでした</span>}
      </div>

      {stored ? (
        <div className="grid gap-1">
          <audio controls src={trialArtifactUrl(trial.id)} aria-label="試行の音声" className="w-full" />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-2xs text-ink-muted">{row.artifactLabel}</span>
            <a className="btn-quiet" href={trialArtifactUrl(trial.id, { download: true })}>
              ダウンロード
            </a>
          </div>
        </div>
      ) : trial.state === "running" ? (
        <p className="text-2xs text-ink-muted" role="status">
          生成中です。送信した本文を表示しています（入力欄の編集とは別です）。
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
        <p className="text-2xs break-words whitespace-pre-wrap text-ink">{row.prompt}</p>
        <p className="text-2xs text-ink-muted">
          演技指示: {labels.instructions} · 話速: {labels.speed}
        </p>
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
      <TrialDefaultAction
        key={trial.id}
        label="このモデルとボイスを既定にする"
        target={defaultTarget}
        disabled={busy || settingsBusy}
        blockedReason={blockedReason}
        onSave={onMakeDefault}
      />
      <p className="text-2xs leading-relaxed text-ink-faint">別のテイクは新しい試行として課金されます。</p>
    </div>
  );
}

function HistoryListItem({
  row,
  selected,
  busy,
  onSelect,
  onDelete,
}: {
  row: TrialHistoryRow;
  selected: boolean;
  busy: boolean;
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
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded border border-line text-2xs text-ink-ghost">
        音声
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
          <code className="min-w-0 truncate text-2xs text-ink-ghost">{row.model}</code>
          {row.voice === null ? null : <span className="text-2xs text-ink-muted">ボイス: {row.voice}</span>}
          <span className="text-2xs text-ink-muted">{row.durationLabel}</span>
          {row.keyEpochLabel ? <span className="text-2xs text-warn">{row.keyEpochLabel}</span> : null}
        </span>
        <span className="min-w-0 truncate text-2xs text-ink" title={row.prompt}>
          {row.prompt}
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
