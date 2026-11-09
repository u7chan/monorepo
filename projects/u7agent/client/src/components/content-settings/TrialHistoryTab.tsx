import { useEffect, useState, type ReactNode } from "react";
import {
  filteredTrials,
  groupTrialsByMonth,
  hasStoredArtifact,
  selectedTrial,
  selectedTrialDetail,
  speechTrialSnapshotLabels,
  trialArtifactSummary,
  trialArtifactUrl,
  trialByteSizeLabel,
  trialCapacityWarningNote,
  trialDimensionLabel,
  trialHistoryRow,
  trialKindLabel,
  trialModelOptions,
  trialStorageNote,
  trialDurationLabel,
  type TrialOutcomeFilter,
} from "../../lib/contentTrials";
import { messageFullTimeLabel } from "../../lib/messageTime";
import { cn } from "../../lib/cn";
import type {
  ContentSettingsResponse,
  ContentTrial,
  ContentTrialArtifactUsageValue,
  ContentTrialArtifactWarningValue,
  ContentTrialSummary,
} from "../../types";
import { useConfirm } from "../ConfirmProvider";
import { ZoomableImage } from "../ImageZoom";
import { MetaChip } from "../model-settings/MetaChip";
import { TrialHistoryFilters, TrialHistoryPanel, TrialHistoryRow } from "./TrialHistory";
import { TrialArtifactMeta, TrialResultViewport } from "./TrialResultViewport";
import { TrialNoteLines } from "./TrialRun";

export type TrialHistoryTabProps = {
  settings: ContentSettingsResponse;
  /** singleColumn は一覧と詳細を 1 画面ずつ出す（広い幅は左右に並べる） */
  singleColumn: boolean;
  /** 全種別の一覧（履歴タブは種別で絞らない） */
  trials: readonly ContentTrialSummary[] | null;
  /** 選択中の試行の全文（取得中は null） */
  detail: ContentTrial | null;
  hasMore: boolean;
  loadingMore: boolean;
  keyEpoch: number;
  artifactUsage: ContentTrialArtifactUsageValue;
  artifactWarning: ContentTrialArtifactWarningValue | null;
  note: { text: string; error: boolean } | null;
  busy: boolean;
  onSelect: (id: string | null) => void;
  onLoadTrial: (id: string) => Promise<ContentTrial | null>;
  onLoadMore: () => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onDeleteAll: (kind?: ContentTrial["kind"]) => Promise<boolean>;
  /** 「この内容で生成」。全文を取れた行だけ渡す */
  onPrefill: (trial: ContentTrial) => void;
  /** 「もう一度生成」。新しい試行として課金する */
  onAnotherTake: (trial: ContentTrial) => Promise<boolean>;
};

/**
 * 設定 → コンテンツ生成 → 履歴。画像・音声・BGM の試行を 1 本の一覧にまとめ、
 * 選んだ行の成果物と「送ったプロンプト」を同じ面に出す。生成の設定は持たない。
 * 広い幅は一覧と詳細を左右に並べ、狭い幅は一覧 → 詳細の 1 画面遷移にする。
 */
export function TrialHistoryTab({
  settings,
  singleColumn,
  trials,
  detail,
  hasMore,
  loadingMore,
  keyEpoch,
  artifactUsage,
  artifactWarning,
  note,
  busy,
  onSelect,
  onLoadTrial,
  onLoadMore,
  onDelete,
  onDeleteAll,
  onPrefill,
  onAnotherTake,
}: TrialHistoryTabProps) {
  const confirm = useConfirm();
  const [kindFilter, setKindFilter] = useState<ContentTrialSummary["kind"] | "all">("all");
  const [modelFilter, setModelFilter] = useState("all");
  const [outcomeFilter, setOutcomeFilter] = useState<TrialOutcomeFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 狭い幅で詳細を開いているか。行を選ぶまで一覧を出す
  const [narrowDetail, setNarrowDetail] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const list = trials ?? [];
  const kindScoped = kindFilter === "all" ? list : list.filter((trial) => trial.kind === kindFilter);
  const filtered = filteredTrials({ trials: list, kind: kindFilter, model: modelFilter, outcome: outcomeFilter });
  const groups = groupTrialsByMonth(filtered);
  const selected = selectedTrial({ trials: filtered, selectedId });
  const selectedKey = selected?.id ?? null;
  // 選択行の全文は controller が取る。選ぶたびに 1 回だけ知らせる
  useEffect(() => {
    onSelect(selectedKey);
  }, [selectedKey, onSelect]);
  const selectedDetail = selectedTrialDetail(detail, selectedKey);
  const filtering = kindFilter !== "all" || modelFilter !== "all" || outcomeFilter !== "all";
  const warning = trialCapacityWarningNote(artifactWarning);
  const models = trialModelOptions(kindScoped);
  const deletable = list.some((trial) => trial.state !== "running");
  // 絞り込みを変えたら、前の行の選択を残さない（見えていない行の詳細を出さない）
  const changeFilter = (apply: () => void) => {
    apply();
    setSelectedId(null);
    setNarrowDetail(false);
  };

  const removeAll = async () => {
    const kind = kindFilter === "all" ? undefined : kindFilter;
    const label = kind === undefined ? "すべての種別" : trialKindLabel(kind);
    const ok = await confirm({
      kind: "confirm",
      title: "試行の履歴を削除",
      body: [`${label}の試行の履歴を削除します。実行中の試行は残ります。`, "この操作は取り消せません。"],
      confirmLabel: "削除",
      danger: true,
    });
    if (ok) void onDeleteAll(kind);
  };

  /** 全文を取ってから、履歴の行を次の操作へ渡す */
  const withFullTrial = async (action: (full: ContentTrial) => void | Promise<void>) => {
    if (selected === null) return;
    setActionError(null);
    const full = await onLoadTrial(selected.id);
    if (full === null) {
      setActionError("この試行の全文を取得できませんでした。再読み込みしてください。");
      return;
    }
    await action(full);
  };

  const prefill = () =>
    withFullTrial((full) => {
      onPrefill(full);
    });

  const anotherTake = () =>
    withFullTrial(async (full) => {
      try {
        if (!(await onAnotherTake(full))) {
          setActionError("生成を開始できませんでした。画面の注記を確認してください。");
        }
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "生成を開始できませんでした。");
      }
    });

  const detailView =
    selected === null ? (
      <p className="text-2xs text-ink-faint">表示できる履歴がありません。</p>
    ) : (
      <div className="grid gap-2">
        {singleColumn ? (
          <button
            type="button"
            className="btn-quiet w-fit"
            onClick={() => {
              setNarrowDetail(false);
            }}
          >
            ← 一覧へ
          </button>
        ) : null}
        <TrialResultViewport
          trial={selected}
          currentKeyEpoch={keyEpoch}
          busy={busy}
          running={selected.state === "running"}
          sentNoun={selected.kind === "speech" ? "本文" : "プロンプト"}
          chips={selected.kind === "speech" ? [`ボイス: ${selected.voice ?? "モデル既定"}`] : undefined}
          artifact={
            hasStoredArtifact(selected) ? (
              <TrialHistoryArtifact
                key={selected.id}
                trial={selected}
                expectedDurationSeconds={settings.bgm.expectedDurationSeconds}
              />
            ) : null
          }
          prompt={selectedDetail?.prompt ?? trialHistoryRow(selected, keyEpoch).promptPreview}
          promptComplete={selectedDetail !== null}
          promptDetail={
            selected.kind === "speech"
              ? `演技指示: ${selectedDetail === null ? "読み込み中…" : speechTrialSnapshotLabels(selectedDetail).instructions} · 話速: ${
                  selectedDetail === null
                    ? selected.speed === null
                      ? "モデル既定"
                      : `${selected.speed} 倍`
                    : speechTrialSnapshotLabels(selectedDetail).speed
                }`
              : undefined
          }
          params={<TrialHistoryParams trial={selected} detail={selectedDetail} currentKeyEpoch={keyEpoch} />}
          onPrefill={prefill}
          onAnotherTake={anotherTake}
          onDelete={onDelete}
        />
        {actionError === null ? null : (
          <p role="alert" className="text-2xs break-words text-warn">
            {actionError}
          </p>
        )}
      </div>
    );

  const listView = (
    <TrialHistoryPanel
      loaded={list.length}
      filtered={filtered.length}
      filtering={filtering}
      groups={groups}
      hasMore={hasMore}
      loadingMore={loadingMore}
      busy={busy}
      deletable={deletable}
      onLoadMore={() => void onLoadMore()}
      onDeleteAll={() => void removeAll()}
      renderRow={(trial) => (
        <TrialHistoryRow
          key={trial.id}
          row={trialHistoryRow(trial, keyEpoch)}
          selected={trial.id === selected?.id}
          busy={busy}
          thumbnail={
            trial.kind === "image"
              ? { kind: "image", url: hasStoredArtifact(trial) ? trialArtifactUrl(trial.id) : null }
              : trial.kind === "speech"
                ? { kind: "speech" }
                : { kind: "bgm" }
          }
          voice={trial.voice}
          onSelect={() => {
            setSelectedId(trial.id);
            setNarrowDetail(true);
          }}
          onDelete={onDelete}
        />
      )}
    />
  );

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)]">
      {/* 狭い幅の詳細では、絞り込みを出さない（一覧へ戻る導線と詳細だけを見せる） */}
      {singleColumn && narrowDetail && selected !== null ? null : (
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
          <TrialHistoryFilters
            kind={kindFilter}
            onChangeKind={(next) => changeFilter(() => setKindFilter(next))}
            models={models}
            modelFilter={modelFilter}
            onChangeModel={(next) => changeFilter(() => setModelFilter(next))}
            outcomeFilter={outcomeFilter}
            onChangeOutcome={(next) => changeFilter(() => setOutcomeFilter(next))}
          />
          <span className="flex-1" />
          <span title={trialStorageNote(artifactUsage)}>
            <MetaChip>
              保存済み {artifactUsage.count} 件 · {trialByteSizeLabel(artifactUsage.bytes)}
            </MetaChip>
          </span>
        </div>
      )}
      <div className="grid gap-1 border-b border-line px-4 py-2">
        <TrialNoteLines alert={null} note={note} />
        {warning === null ? null : (
          <p role="status" className="text-2xs leading-relaxed break-words text-warn">
            {warning}
          </p>
        )}
      </div>

      {singleColumn ? (
        <div className="min-h-0 overflow-y-auto px-3 py-2">
          {narrowDetail && selected !== null ? detailView : listView}
        </div>
      ) : (
        <div className="grid min-h-0 grid-cols-[352px_minmax(0,1fr)]">
          <div className="min-h-0 overflow-y-auto border-r border-line px-3 py-2">{listView}</div>
          <div className="min-h-0 overflow-y-auto px-4 py-3">{detailView}</div>
        </div>
      )}
    </div>
  );
}

/** 履歴の詳細の成果物。種別ごとにプレビュー / 再生を出し、保存が無い行は何も出さない */
function TrialHistoryArtifact({
  trial,
  expectedDurationSeconds,
}: {
  trial: ContentTrialSummary;
  expectedDurationSeconds: number;
}) {
  const [measured, setMeasured] = useState<number | null>(null);
  if (!hasStoredArtifact(trial)) return null;
  if (trial.kind === "image") {
    return (
      <div className="grid gap-1">
        <ZoomableImage src={trialArtifactUrl(trial.id)} alt="試行の結果" variant="markdown" />
        <TrialArtifactMeta trialId={trial.id} label={trialArtifactSummary(trial)}>
          {trialDimensionLabel(trial) ? null : <p className="text-2xs text-ink-faint">実寸を読めませんでした。</p>}
        </TrialArtifactMeta>
      </div>
    );
  }
  return (
    <div className="grid gap-1">
      <audio
        controls
        src={trialArtifactUrl(trial.id)}
        aria-label={trial.kind === "bgm" ? "試行のBGM" : "試行の音声"}
        className="w-full"
        onLoadedMetadata={(event) => setMeasured(event.currentTarget.duration)}
      />
      <TrialArtifactMeta trialId={trial.id} label={trialArtifactSummary(trial)}>
        {trial.kind === "bgm" ? (
          <p className="text-2xs text-ink-faint">
            モデル仕様の目安: {expectedDurationSeconds} 秒 · 実測:{" "}
            {measured === null ? "—" : `${measured.toFixed(1)} 秒`}
          </p>
        ) : null}
      </TrialArtifactMeta>
    </div>
  );
}

/** 履歴の詳細のパラメータ。送信時の値をそのまま出し、現在の保存値とは混ぜない */
function TrialHistoryParams({
  trial,
  detail,
  currentKeyEpoch,
}: {
  trial: ContentTrialSummary;
  detail: ContentTrial | null;
  currentKeyEpoch: number;
}) {
  const at = trial.finishedAt ?? trial.startedAt;
  const snapshot = detail === null ? null : speechTrialSnapshotLabels(detail);
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3">
      <Param label="種別" value={trialKindLabel(trial.kind)} />
      <Param label="モデル" value={<code>{trial.model}</code>} />
      <Param label="形式" value={trial.artifact?.format.toUpperCase() ?? "—"} />
      <Param label="実寸" value={trialDimensionLabel(trial) ?? "—"} />
      <Param label="サイズ" value={trial.artifact === null ? "—" : trialByteSizeLabel(trial.artifact.bytes)} />
      <Param label="所要" value={trialDurationLabel(trial.durationMs)} />
      <Param label="実行" value={messageFullTimeLabel(at)} />
      <Param label="キー世代" value={trial.keyEpoch < currentKeyEpoch ? `旧キー（世代 ${trial.keyEpoch}）` : "現行"} />
      {trial.kind === "speech" ? <Param label="ボイス" value={trial.voice ?? "モデル既定"} /> : null}
      {trial.kind === "speech" ? (
        <Param label="話速" value={snapshot?.speed ?? (trial.speed === null ? "モデル既定" : `${trial.speed} 倍`)} />
      ) : null}
      {trial.kind === "speech" ? (
        <Param label="演技指示" value={snapshot?.instructions ?? "読み込み中…"} className="col-span-full" />
      ) : null}
    </dl>
  );
}

function Param({ label, value, className }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 bg-raised px-2 py-1.5", className)}>
      <dt className="text-3xs tracking-label text-ink-ghost uppercase">{label}</dt>
      <dd className="mt-0.5 text-2xs break-words text-ink">{value}</dd>
    </div>
  );
}
