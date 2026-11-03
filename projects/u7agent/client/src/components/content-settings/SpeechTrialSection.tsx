import { useEffect, useState } from "react";
import {
  filteredTrials,
  groupTrialsByMonth,
  hasStoredArtifact,
  selectedTrial,
  selectedTrialDetail,
  speechTrialDraftOf,
  speechTrialRequest,
  speechTrialSnapshotLabels,
  trialArtifactSummary,
  trialArtifactUrl,
  trialHistoryRow,
  trialModelOptions,
  trialPanelState,
  trialStartBlockedReason,
  type SpeechTrialDraft,
  type TrialOutcomeFilter,
  type TrialRequestOrigin,
} from "../../lib/contentTrials";
import { SPEECH_SPEED_MIN, SPEECH_SPEED_STEP, speechSpeedStep } from "../../lib/contentSettings";
import { speechTrialDefaultTarget } from "../../lib/trialDefault";
import type {
  ContentSettingsResponse,
  ContentTrial,
  ContentTrialArtifactUsageValue,
  ContentTrialArtifactWarningValue,
  ContentTrialSummary,
  CreateContentTrialBody,
  UpdateContentSpeechBody,
} from "../../types";
import { MinusIcon, PlusIcon } from "../icons";
import { TRIAL_HISTORY_PREVIEW_COUNT, TrialHistoryFilters, TrialHistoryPanel, TrialHistoryRow } from "./TrialHistory";
import { TrialArtifactMeta, TrialResultViewport } from "./TrialResultViewport";
import { TrialEmptyNote, TrialNoteLines, TrialRunControls, TrialSection } from "./TrialRun";
import { TrialDefaultAction, UNCONFIGURED_BLOCKED_NOTE } from "./TrialDefaultAction";

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
  /** 一覧は要約（本文は抜粋）。選択行の全文は `detail` / `onLoadTrial` で取る */
  trials: readonly ContentTrialSummary[] | null;
  /** 選択中の試行の全文（取得中は null） */
  detail: ContentTrial | null;
  /** 続きのページがあるか */
  hasMore: boolean;
  loadingMore: boolean;
  keyEpoch: number;
  artifactUsage: ContentTrialArtifactUsageValue;
  /** 保存容量の警告。しきい値と判定は一覧の応答が持ち、返さない間は null */
  artifactWarning: ContentTrialArtifactWarningValue | null;
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
  /** 選択中の試行を画面へ知らせる（全文の取得は画面が行う） */
  onChangeSelection: (id: string | null) => void;
  /** 履歴の行の全文を取る（再実行・入力欄に戻すで使う） */
  onLoadTrial: (id: string) => Promise<ContentTrial | null>;
  /** 続きのページを読む */
  onLoadMore: () => Promise<boolean>;
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
  detail,
  hasMore,
  loadingMore,
  keyEpoch,
  artifactUsage,
  artifactWarning,
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
  onChangeSelection,
  onLoadTrial,
  onLoadMore,
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
    // 同期未確認は保存だけを止める状態で、試行は画面の値でできる（バナーと既定への保存の理由で伝える）
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
  const visible = showAll ? filtered : filtered.slice(0, TRIAL_HISTORY_PREVIEW_COUNT);
  const groups = groupTrialsByMonth(visible);
  const filtering = modelFilter !== "all" || outcomeFilter !== "all";
  // 選択行の全文は画面（controller）が取る。選ぶたびに 1 回だけ知らせる
  const selectedKey = selected?.id ?? null;
  useEffect(() => {
    onChangeSelection(selectedKey);
  }, [selectedKey, onChangeSelection]);
  const selectedDetail = selectedTrialDetail(detail, selectedKey);
  const stored = selected !== null && hasStoredArtifact(selected);
  // 演技指示は長いので一覧に載らない。全文を取れるまでは「読み込み中」と出す（指定なしと混同しない）
  const snapshot = selectedDetail === null ? null : speechTrialSnapshotLabels(selectedDetail);

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
    <TrialSection
      artifactUsage={artifactUsage}
      artifactWarning={artifactWarning}
      description="画面の値で生成だけを試します。モデルとボイスの保存値は変えません。送った本文・演技指示・話速と結果はアプリのデータ領域に履歴として残ります（時間ベースでは消えません）。"
    >
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

      <TrialRunControls
        busy={busy}
        running={running !== null}
        panel={panel}
        blocked={blocked}
        onStart={() => void start(draft, model, voice, "form")}
        onCancel={() => {
          if (running) void onCancel(running.id);
        }}
      />

      <TrialNoteLines alert={inputError} note={note} />

      {selected === null ? (
        <TrialEmptyNote />
      ) : (
        <TrialResultViewport
          trial={selected}
          currentKeyEpoch={keyEpoch}
          busy={busy}
          running={running !== null}
          sentNoun="本文"
          chips={[`ボイス: ${selected.voice ?? "モデル既定"}`]}
          artifact={
            stored ? (
              <div className="grid gap-1">
                <audio controls src={trialArtifactUrl(selected.id)} aria-label="試行の音声" className="w-full" />
                <TrialArtifactMeta trialId={selected.id} label={trialArtifactSummary(selected)} />
              </div>
            ) : null
          }
          prompt={selectedDetail?.prompt ?? trialHistoryRow(selected, keyEpoch).promptPreview}
          promptDetail={`演技指示: ${snapshot?.instructions ?? "読み込み中…"} · 話速: ${snapshot?.speed ?? "—"}`}
          defaultAction={
            <TrialDefaultAction
              key={selected.id}
              label="このモデルとボイスを既定にする"
              target={defaultTarget}
              disabled={busy || settingsBusy}
              blockedReason={defaultBlockedReason}
              onSave={onMakeDefault}
            />
          }
          onDelete={onDelete}
          onRestore={async () => {
            const full = await onLoadTrial(selected.id);
            if (!full) return;
            setInputError(null);
            onChangeDraft(speechTrialDraftOf(full));
          }}
          onAnotherTake={async () => {
            // 始めた行をビューポートへ寄せる。開始できなければ選択を動かさない
            const full = await onLoadTrial(selected.id);
            if (!full) return;
            const started = await start(speechTrialDraftOf(full), full.model, full.voice ?? "", "another-take");
            if (started) setSelectedId(null);
          }}
        />
      )}

      {list.length === 0 ? null : (
        <TrialHistoryPanel
          loaded={list.length}
          filtered={filtered.length}
          filtering={filtering}
          groups={groups}
          showAll={showAll}
          hasMore={hasMore}
          loadingMore={loadingMore}
          busy={busy}
          deletable={list.some((trial) => trial.state !== "running")}
          filters={
            <TrialHistoryFilters
              models={models}
              modelFilter={modelFilter}
              onChangeModel={setModelFilter}
              outcomeFilter={outcomeFilter}
              onChangeOutcome={setOutcomeFilter}
            />
          }
          onToggleShowAll={() => setShowAll((current) => !current)}
          onLoadMore={() => void onLoadMore()}
          onDeleteAll={() => void onDeleteAll()}
          renderRow={(trial) => (
            <TrialHistoryRow
              key={trial.id}
              row={trialHistoryRow(trial, keyEpoch)}
              selected={trial.id === selected?.id}
              busy={busy}
              thumbnail={{ kind: "speech" }}
              voice={trial.voice}
              onSelect={() => setSelectedId(trial.id)}
              onDelete={onDelete}
            />
          )}
        />
      )}
    </TrialSection>
  );
}
