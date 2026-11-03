import { useEffect, useState } from "react";
import {
  evidenceNote,
  filteredTrials,
  groupTrialsByMonth,
  hasStoredArtifact,
  imageTrialRequest,
  selectedTrial,
  selectedTrialDetail,
  trialArtifactSummary,
  trialArtifactUrl,
  trialDimensionLabel,
  trialEvidence,
  trialHistoryRow,
  trialModelOptions,
  trialPanelState,
  trialStartBlockedReason,
  type TrialOutcomeFilter,
} from "../../lib/contentTrials";
import { imageTrialDefaultTarget } from "../../lib/trialDefault";
import type {
  ContentSettingsResponse,
  ContentTrial,
  ContentTrialArtifactUsageValue,
  ContentTrialArtifactWarningValue,
  ContentTrialSummary,
  CreateContentTrialBody,
  UpdateContentImageBody,
} from "../../types";
import { ZoomableImage } from "../ImageZoom";
import { TRIAL_HISTORY_PREVIEW_COUNT, TrialHistoryFilters, TrialHistoryPanel, TrialHistoryRow } from "./TrialHistory";
import { TrialArtifactMeta, TrialResultViewport } from "./TrialResultViewport";
import { TrialEmptyNote, TrialNoteLines, TrialRunControls, TrialSection } from "./TrialRun";
import { TrialDefaultAction, UNCONFIGURED_BLOCKED_NOTE } from "./TrialDefaultAction";

export type ImageTrialSectionProps = {
  settings: ContentSettingsResponse;
  /** 画面で選択中のモデル（下書き優先）。保存前でも画面の値で試行する */
  model: string;
  /** 一覧は要約（本文は抜粋）。選択行の全文は `detail` / `onLoadTrial` で取る */
  trials: readonly ContentTrialSummary[] | null;
  /** 選択中の試行の全文（取得中は null） */
  detail: ContentTrial | null;
  /** 続きのページがあるか */
  hasMore: boolean;
  loadingMore: boolean;
  /** 現在のキー世代。証拠と「旧キー」の判定に使う */
  keyEpoch: number;
  /** 保存容量（`succeeded` + 保存済みだけ）。一覧の取得前は 0 件 */
  artifactUsage: ContentTrialArtifactUsageValue;
  /** 保存容量の警告。しきい値と判定は一覧の応答が持ち、返さない間は null */
  artifactWarning: ContentTrialArtifactWarningValue | null;
  /** 試行の操作（開始 / 中断 / 削除 / 一覧の取得失敗）の注記。設定の注記とは別の行に出す */
  note: { text: string; error: boolean } | null;
  busy: boolean;
  /** 設定の保存中。既定の保存を重ねない（試行の `busy` とは別の軸） */
  settingsBusy: boolean;
  /** 試行のモデルを既定として保存する。成功したら呼び出し側が下書きを捨てる */
  onMakeDefault: (input: UpdateContentImageBody) => Promise<boolean>;
  /** 試行のプロンプト下書き。面を切り替えても失わないよう、呼び出し側が持つ */
  prompt: string;
  onChangePrompt: (prompt: string) => void;
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
 * 設定に反映しない画像の試行。結果は 1 つのビューポート + 履歴セレクタで見せ、履歴の行を選ぶと
 * ビューポートが切り替わる。成果物はサーバーの trial id 経由で配信し、保存していない行（段階 1 の
 * `none`）は「記録のみ」として再生・ダウンロードを出さない。
 * キー未設定・全体 OFF・runtime 不可でも履歴は表示し、新規生成だけを止める。
 */
export function ImageTrialSection({
  settings,
  model,
  trials,
  keyEpoch,
  artifactUsage,
  artifactWarning,
  note,
  busy,
  settingsBusy,
  onMakeDefault,
  prompt,
  onChangePrompt,
  onStart,
  onCancel,
  onDelete,
  onDeleteAll,
  detail,
  hasMore,
  loadingMore,
  onChangeSelection,
  onLoadTrial,
  onLoadMore,
}: ImageTrialSectionProps) {
  const [showAll, setShowAll] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState("all");
  const [outcomeFilter, setOutcomeFilter] = useState<TrialOutcomeFilter>("all");
  // 一覧は全種別を 1 回で取るため、面ごとに自分の種別だけを出す（音声の履歴を混ぜない）
  const list = (trials ?? []).filter((trial) => trial.kind === "image");
  const panel = trialPanelState({
    runtimeAvailable: settings.runtimeAvailable,
    configured: settings.configured,
    enabled: settings.enabled,
    synced: true,
    trials: list,
  });
  const running = list.find((trial) => trial.state === "running") ?? null;
  const selected = selectedTrial({ trials: list, selectedId });
  // 同じモデルを保存しても何も変わらないため、結果との差分があるときだけ導線を出す
  const defaultTarget = selected ? imageTrialDefaultTarget({ settings, trialModel: selected.model }) : null;
  // 保存フォームはキー未設定では出ない。同じ PUT を呼ぶ導線も履歴の閲覧だけを残して止める
  const defaultBlockedReason = settings.configured ? null : UNCONFIGURED_BLOCKED_NOTE;
  const blocked = trialStartBlockedReason({
    runtimeAvailable: settings.runtimeAvailable,
    configured: settings.configured,
    enabled: settings.enabled,
    keyAvailable: settings.keyAvailable,
    running: running !== null,
    prompt,
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

  return (
    <TrialSection
      artifactUsage={artifactUsage}
      artifactWarning={artifactWarning}
      description="画面の値で生成だけを試します。モデルの保存値は変えません。送ったプロンプトと結果はアプリのデータ領域に履歴として残ります（時間ベースでは消えません）。"
    >
      <label className="grid min-w-0 gap-1">
        <span className="text-2xs text-ink-muted">プロンプト（履歴に保存されます）</span>
        <textarea
          className="field min-h-20 min-w-0 resize-y text-xs"
          value={prompt}
          placeholder="生成したい画像を書いてください（例: 朝の海辺を散歩する猫）"
          aria-label="試行のプロンプト"
          spellCheck={false}
          onChange={(event) => onChangePrompt(event.currentTarget.value)}
        />
      </label>

      <TrialRunControls
        busy={busy}
        running={running !== null}
        panel={panel}
        blocked={blocked}
        onStart={() => void onStart(imageTrialRequest({ model, prompt, origin: "form" }))}
        onCancel={() => {
          if (running) void onCancel(running.id);
        }}
      />

      {/* 試行の操作の結果はこの面の中だけに出す（設定の注記と場所を奪い合わない） */}
      <TrialNoteLines alert={null} note={note} />

      {selected === null ? (
        <TrialEmptyNote />
      ) : (
        <TrialResultViewport
          trial={selected}
          currentKeyEpoch={keyEpoch}
          busy={busy}
          running={running !== null}
          sentNoun="プロンプト"
          artifact={
            stored ? (
              <div className="grid gap-1">
                {/* 拡大は会話の画像と同じ dialog に任せる（同じ寸法規則を 2 か所に増やさない） */}
                <ZoomableImage src={trialArtifactUrl(selected.id)} alt="試行の結果" variant="markdown" />
                <TrialArtifactMeta trialId={selected.id} label={trialArtifactSummary(selected)}>
                  {trialDimensionLabel(selected) ? null : (
                    <p className="text-2xs text-ink-faint">実寸を読めませんでした。</p>
                  )}
                </TrialArtifactMeta>
              </div>
            ) : null
          }
          prompt={selectedDetail?.prompt ?? trialHistoryRow(selected, keyEpoch).promptPreview}
          defaultAction={
            <TrialDefaultAction
              key={selected.id}
              label="このモデルを既定にする"
              target={defaultTarget}
              disabled={busy || settingsBusy}
              blockedReason={defaultBlockedReason}
              onSave={onMakeDefault}
            />
          }
          onDelete={onDelete}
          onRestore={async () => {
            const full = await onLoadTrial(selected.id);
            if (full) onChangePrompt(full.prompt);
          }}
          onAnotherTake={async () => {
            // 始めた行をビューポートへ寄せる。開始できなければ選択を動かさない
            const full = await onLoadTrial(selected.id);
            if (!full) return;
            const started = await onStart(
              imageTrialRequest({ model: full.model, prompt: full.prompt, origin: "another-take" }),
            );
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
          renderRow={(trial) => {
            const row = trialHistoryRow(trial, keyEpoch);
            return (
              <TrialHistoryRow
                key={trial.id}
                row={row}
                selected={trial.id === selected?.id}
                busy={busy}
                thumbnail={{ kind: "image", url: row.artifactUrl }}
                onSelect={() => setSelectedId(trial.id)}
                onDelete={onDelete}
              />
            );
          }}
        />
      )}
    </TrialSection>
  );
}

/** 証拠の 1 行。モデル選択の直下に置き、緑のバッジにはしない */
export function EvidenceLine({
  trials,
  model,
  voice,
  keyEpoch,
  now,
}: {
  trials: readonly ContentTrialSummary[] | null;
  /** 画面で選択中のモデル（下書き優先）。証拠はこのモデルの実績だけを数える */
  model: string;
  /** 音声はボイスも一致する実績だけを数える。画像は省略 */
  voice?: string;
  keyEpoch: number;
  now: number;
}) {
  const evidence = trialEvidence({
    trials: trials ?? [],
    currentKeyEpoch: keyEpoch,
    currentModel: model,
    ...(voice === undefined ? {} : { currentVoice: voice }),
    now,
  });
  return (
    <p className="text-2xs leading-relaxed text-ink-muted">
      {evidenceNote(evidence, { now })}
      <span className="text-ink-faint">（チャットの生成は含めません）</span>
    </p>
  );
}
