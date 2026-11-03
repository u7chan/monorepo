import { useEffect, useState } from "react";
import {
  BGM_TRIAL_PROMPT_MAX_LENGTH,
  bgmDurationLabel,
  bgmTrialRequest,
  filteredTrials,
  groupTrialsByMonth,
  hasStoredArtifact,
  selectedTrial,
  selectedTrialDetail,
  trialArtifactSummary,
  trialArtifactUrl,
  trialHistoryRow,
  trialPanelState,
  trialStartBlockedReason,
  type TrialOutcomeFilter,
  type TrialRequestOrigin,
} from "../../lib/contentTrials";
import type {
  ContentSettingsResponse,
  ContentTrial,
  ContentTrialArtifactUsageValue,
  ContentTrialSummary,
  CreateContentTrialBody,
} from "../../types";
import { TRIAL_HISTORY_PREVIEW_COUNT, TrialHistoryFilters, TrialHistoryPanel, TrialHistoryRow } from "./TrialHistory";
import { TrialArtifactMeta, TrialResultViewport } from "./TrialResultViewport";
import { TrialEmptyNote, TrialNoteLines, TrialRunControls, TrialSection } from "./TrialRun";

export type BgmTrialSectionProps = {
  settings: ContentSettingsResponse;
  /** 固定モデル。未設定では空文字（開始は `trialStartBlockedReason` が止める） */
  model: string;
  /** 一覧は要約（本文は抜粋）。選択行の全文は `detail` / `onLoadTrial` で取る */
  trials: readonly ContentTrialSummary[] | null;
  /** 選択中の試行の全文（取得中は null） */
  detail: ContentTrial | null;
  /** 続きのページがあるか */
  hasMore: boolean;
  loadingMore: boolean;
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
  /** 選択中の試行を画面へ知らせる（全文の取得は画面が行う） */
  onChangeSelection: (id: string | null) => void;
  /** 履歴の行の全文を取る（もう一度試す・入力欄に戻すで使う） */
  onLoadTrial: (id: string) => Promise<ContentTrial | null>;
  /** 続きのページを読む */
  onLoadMore: () => Promise<boolean>;
};

/**
 * 設定に反映しない BGM の試行。モデルは固定なので選択肢を持たず、履歴はプロンプト履歴になる。
 * 入力はプロンプトだけ（尺 / BPM / ループは非ゴール）で、結果は 1 つの再生ビューポート + 履歴セレクタ。
 */
export function BgmTrialSection({
  settings,
  model,
  trials,
  detail,
  hasMore,
  loadingMore,
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
  onChangeSelection,
  onLoadTrial,
  onLoadMore,
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
  const visible = showAll ? filtered : filtered.slice(0, TRIAL_HISTORY_PREVIEW_COUNT);
  const groups = groupTrialsByMonth(visible);
  // 選択行の全文は画面（controller）が取る。選ぶたびに 1 回だけ知らせる
  const selectedKey = selected?.id ?? null;
  useEffect(() => {
    onChangeSelection(selectedKey);
  }, [selectedKey, onChangeSelection]);
  const selectedDetail = selectedTrialDetail(detail, selectedKey);

  /** 検証を通ったときだけ要求を出し、開始できたかを返す（別テイクの自動選択に使う） */
  const start = async (value: string, nextModel: string, origin: TrialRequestOrigin): Promise<boolean> => {
    const request = bgmTrialRequest({ prompt: value, model: nextModel, origin });
    if (!request.ok) {
      setInputError(request.error);
      return false;
    }
    setInputError(null);
    return onStart(request.input);
  };

  /** 履歴の行の「もう一度試す」。本文は全文を取り直してから送る（一覧は抜粋しか持たない） */
  const retry = async (id: string): Promise<boolean> => {
    const full = await onLoadTrial(id);
    return full === null ? false : start(full.prompt, model, "history");
  };

  return (
    <TrialSection
      artifactUsage={artifactUsage}
      description="固定モデルで生成だけを試します。保存する設定はありません。送ったプロンプトと結果はアプリのデータ領域に履歴として残ります（時間ベースでは消えません）。"
    >
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
        <span className="text-ink-soft">ボーカルが入らないこと・正確なBPMや尺・シームレスループは保証しません</span>。
      </p>

      <TrialRunControls
        busy={busy}
        running={running !== null}
        panel={panel}
        blocked={blocked}
        onStart={() => void start(prompt, model, "form")}
        onCancel={() => {
          if (running) void onCancel(running.id);
        }}
      />

      <TrialNoteLines alert={inputError} note={note} />

      {selected === null ? (
        <TrialEmptyNote />
      ) : (
        <BgmResultViewport
          // 実測の尺は選んだ試行ごとに読み直す（前の行の秒数を残さない）
          key={selected.id}
          trial={selected}
          detail={selectedDetail}
          currentKeyEpoch={keyEpoch}
          busy={busy}
          running={running !== null}
          expectedDurationSeconds={settings.bgm.expectedDurationSeconds}
          onDelete={onDelete}
          onRestore={async () => {
            const full = await onLoadTrial(selected.id);
            if (!full) return;
            setInputError(null);
            onChangePrompt(full.prompt);
          }}
          onAnotherTake={async () => {
            // 始めた行をビューポートへ寄せる。開始できなければ選択を動かさない
            const full = await onLoadTrial(selected.id);
            if (!full) return;
            if (await start(full.prompt, model, "another-take")) setSelectedId(null);
          }}
        />
      )}

      {list.length === 0 ? null : (
        <TrialHistoryPanel
          loaded={list.length}
          filtered={filtered.length}
          filtering={outcomeFilter !== "all"}
          groups={groups}
          showAll={showAll}
          hasMore={hasMore}
          loadingMore={loadingMore}
          busy={busy}
          deletable={list.some((trial) => trial.state !== "running")}
          filters={<TrialHistoryFilters outcomeFilter={outcomeFilter} onChangeOutcome={setOutcomeFilter} />}
          onToggleShowAll={() => setShowAll((current) => !current)}
          onLoadMore={() => void onLoadMore()}
          onDeleteAll={() => void onDeleteAll()}
          renderRow={(trial) => (
            <TrialHistoryRow
              key={trial.id}
              row={trialHistoryRow(trial, keyEpoch)}
              selected={trial.id === selected?.id}
              busy={busy}
              thumbnail={{ kind: "bgm" }}
              showModel={false}
              onSelect={() => setSelectedId(trial.id)}
              onRetry={() => void retry(trial.id)}
              onDelete={onDelete}
            />
          )}
        />
      )}
    </TrialSection>
  );
}

/**
 * 1 つの再生ビューポート。表示中の試行のスナップショットだけを出し、下書きのプロンプトとは混ぜない。
 * 実測の尺は `<audio>` のメタデータから読み、読めるまでは `—` にする（目安尺と混ぜない）。
 */
function BgmResultViewport({
  trial,
  detail,
  currentKeyEpoch,
  busy,
  running,
  expectedDurationSeconds,
  onDelete,
  onRestore,
  onAnotherTake,
}: {
  trial: ContentTrialSummary;
  /** 選択行の全文。取得中は null で、本文は抜粋を出す */
  detail: ContentTrial | null;
  currentKeyEpoch: number;
  busy: boolean;
  running: boolean;
  expectedDurationSeconds: number;
  onDelete: (id: string) => Promise<boolean>;
  onRestore: () => Promise<void>;
  onAnotherTake: () => Promise<void>;
}) {
  const [measured, setMeasured] = useState<number | null>(null);

  return (
    <TrialResultViewport
      trial={trial}
      currentKeyEpoch={currentKeyEpoch}
      busy={busy}
      running={running}
      sentNoun="プロンプト"
      artifact={
        hasStoredArtifact(trial) ? (
          <div className="grid gap-1">
            {/* 実測の尺は再生可能なバイト列でしか読めないため、プレイヤーのメタデータから取る */}
            <audio
              controls
              src={trialArtifactUrl(trial.id)}
              aria-label="試行のBGM"
              className="w-full"
              onLoadedMetadata={(event) => setMeasured(event.currentTarget.duration)}
            />
            <TrialArtifactMeta trialId={trial.id} label={trialArtifactSummary(trial)}>
              <p className="text-2xs text-ink-faint">
                モデル仕様の目安: {expectedDurationSeconds} 秒 · 実測: {bgmDurationLabel(measured)}
              </p>
            </TrialArtifactMeta>
          </div>
        ) : null
      }
      prompt={detail?.prompt ?? trialHistoryRow(trial, currentKeyEpoch).promptPreview}
      onDelete={onDelete}
      onRestore={onRestore}
      onAnotherTake={onAnotherTake}
    />
  );
}
