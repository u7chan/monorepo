import { useState } from "react";
import {
  evidenceNote,
  filteredTrials,
  groupTrialsByMonth,
  hasStoredArtifact,
  trialEvidence,
  reusableTrial,
  selectedTrial,
  trialArtifactUrl,
  trialByteSizeLabel,
  trialDimensionLabel,
  trialHistoryRow,
  trialModelOptions,
  trialPanelState,
  trialStartBlockedReason,
  trialStateLabel,
  type TrialHistoryRow,
  type TrialOutcomeFilter,
} from "../../lib/contentTrials";
import { cn } from "../../lib/cn";
import { imageTrialDefaultTarget } from "../../lib/trialDefault";
import type {
  ContentSettingsResponse,
  ContentTrial,
  ContentTrialArtifactUsageValue,
  UpdateContentImageBody,
} from "../../types";
import { CheckIcon, TrashIcon } from "../icons";
import { ZoomableImage } from "../ImageZoom";
import { TrialDefaultAction } from "./TrialDefaultAction";

/** 履歴の既定表示件数。全件は「すべて見る」で開く（時間ベースの自動削除はしない） */
const HISTORY_PREVIEW_COUNT = 3;

/** 成功 / 失敗の絞り込み。中止・中断はどちらにも含めない */
const OUTCOME_OPTIONS: { value: TrialOutcomeFilter; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "succeeded", label: "成功" },
  { value: "failed", label: "失敗" },
];

export type ImageTrialSectionProps = {
  settings: ContentSettingsResponse;
  /** 画面で選択中のモデル（下書き優先）。保存前でも画面の値で試行する */
  model: string;
  /** 一覧を取得できていない間は null */
  trials: readonly ContentTrial[] | null;
  /** 現在のキー世代。証拠と「旧キー」の判定に使う */
  keyEpoch: number;
  /** 保存容量（`succeeded` + 保存済みだけ）。一覧の取得前は 0 件 */
  artifactUsage: ContentTrialArtifactUsageValue;
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
  onStart: (input: { kind: "image"; model: string; prompt: string }) => Promise<boolean>;
  onCancel: (id: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onDeleteAll: () => Promise<boolean>;
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
  const visible = showAll ? filtered : filtered.slice(0, HISTORY_PREVIEW_COUNT);
  const groups = groupTrialsByMonth(visible);
  const filtering = modelFilter !== "all" || outcomeFilter !== "all";

  return (
    <section className="grid min-w-0 gap-2 border-t border-line pt-3">
      <div className="grid gap-0.5">
        <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">設定に反映しない試行</h3>
        <p className="text-2xs leading-relaxed text-ink-muted">
          画面の値で生成だけを試します。モデルの保存値は変えません。送ったプロンプトと結果はアプリのデータ領域に
          履歴として残ります（時間ベースでは消えません）。
        </p>
      </div>

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

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || blocked !== null}
          onClick={() => void onStart({ kind: "image", model, prompt })}
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

      {/* 試行の操作の結果はこの面の中だけに出す（設定の注記と場所を奪い合わない） */}
      {note ? (
        <p role="status" className={cn("text-2xs break-words", note.error ? "text-warn" : "text-ink-muted")}>
          {note.text}
        </p>
      ) : null}

      {selected ? (
        <ResultViewport
          trial={selected}
          currentKeyEpoch={keyEpoch}
          trials={list}
          busy={busy}
          running={running !== null}
          defaultTarget={defaultTarget}
          settingsBusy={settingsBusy}
          onMakeDefault={onMakeDefault}
          onDelete={onDelete}
          onRestorePrompt={() => onChangePrompt(selected.prompt)}
          onAnotherTake={() => void onStart({ kind: "image", model: selected.model, prompt: selected.prompt })}
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
              保存容量: {artifactUsage.count} 件 · {trialByteSizeLabel(artifactUsage.bytes)}
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
      return "音声の設定を確認できていません。試行はできますが、保存はできません。";
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
 * 1 つの結果ビューポート。表示中の試行のスナップショットだけを出し、下書きのプロンプトとは混ぜない。
 * 選んだ行が実行中でも、送信したプロンプトと状態はその行の値で固定される。
 */
function ResultViewport({
  trial,
  currentKeyEpoch,
  trials,
  busy,
  running,
  defaultTarget,
  settingsBusy,
  onMakeDefault,
  onDelete,
  onRestorePrompt,
  onAnotherTake,
}: {
  trial: ContentTrial;
  currentKeyEpoch: number;
  trials: readonly ContentTrial[];
  busy: boolean;
  running: boolean;
  /** 既定として保存する本文。保存値と同じなら null（導線を出さない） */
  defaultTarget: UpdateContentImageBody | null;
  settingsBusy: boolean;
  onMakeDefault: (input: UpdateContentImageBody) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onRestorePrompt: () => void;
  onAnotherTake: () => void;
}) {
  const row = trialHistoryRow(trial, currentKeyEpoch);
  const stored = hasStoredArtifact(trial);
  const dimensions = trialDimensionLabel(trial);
  const reuse = reusableTrial({ trials, kind: trial.kind, model: trial.model, prompt: trial.prompt });

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
          {/* 拡大は会話の画像と同じ dialog に任せる（同じ寸法規則を 2 か所に増やさない） */}
          <ZoomableImage src={trialArtifactUrl(trial.id)} alt="試行の結果" variant="markdown" />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-2xs text-ink-muted">{row.artifactLabel}</span>
            <a className="btn-quiet" href={trialArtifactUrl(trial.id, { download: true })}>
              ダウンロード
            </a>
          </div>
          {dimensions ? null : <p className="text-2xs text-ink-faint">実寸を読めませんでした。</p>}
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
        <button type="button" className="btn-quiet" disabled={busy} onClick={onRestorePrompt}>
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
        label="このモデルを既定にする"
        target={defaultTarget}
        disabled={busy || settingsBusy}
        onSave={onMakeDefault}
      />
      <p className="text-2xs leading-relaxed text-ink-faint">
        {reuse
          ? "同じ入力の保存済みの結果があるため、生成し直しても課金されません。"
          : "別のテイクは新しい試行として課金されます。"}
      </p>
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
      {/* 画像は保存済みの行だけサムネイルを出す（無い行は「記録のみ」） */}
      {row.artifactUrl ? (
        <img src={row.artifactUrl} alt="" loading="lazy" className="h-10 w-10 shrink-0 rounded object-cover" />
      ) : (
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded border border-line text-2xs text-ink-ghost">
          記録
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
          <code className="min-w-0 truncate text-2xs text-ink-ghost">{row.model}</code>
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

/** 証拠の 1 行。モデル選択の直下に置き、緑のバッジにはしない */
export function EvidenceLine({
  trials,
  model,
  voice,
  keyEpoch,
  now,
}: {
  trials: readonly ContentTrial[] | null;
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
