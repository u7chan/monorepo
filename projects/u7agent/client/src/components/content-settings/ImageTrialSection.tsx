import { useState } from "react";
import {
  evidenceNote,
  imageTrialEvidence,
  latestTrial,
  trialHistoryRow,
  trialPanelState,
  trialStartBlockedReason,
  type TrialHistoryRow,
} from "../../lib/contentTrials";
import { cn } from "../../lib/cn";
import type { ContentSettingsResponse, ContentTrial } from "../../types";
import { CheckIcon, TrashIcon } from "../icons";

/** 履歴の既定表示件数。全件は「すべて表示」で開く（時間ベースの自動削除はしない） */
const HISTORY_PREVIEW_COUNT = 3;

export type ImageTrialSectionProps = {
  settings: ContentSettingsResponse;
  /** 一覧を取得できていない間は null */
  trials: readonly ContentTrial[] | null;
  /** 現在のキー世代。証拠と「旧キー」の判定に使う */
  keyEpoch: number;
  busy: boolean;
  /** 試行のプロンプト下書き。面を切り替えても失わないよう、呼び出し側が持つ */
  prompt: string;
  onChangePrompt: (prompt: string) => void;
  onStart: (input: { kind: "image"; model: string; prompt: string }) => Promise<boolean>;
  onCancel: (id: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onDeleteAll: () => Promise<boolean>;
};

/**
 * 設定に反映しない画像の試行。段階 1 は成果物を保存しないため、結果は
 * 「生成 + 終端の記録」だけで、再生・ダウンロード・同一入力の再利用は出さない。
 * キー未設定・全体 OFF・runtime 不可でも履歴は表示し、新規生成だけを止める。
 */
export function ImageTrialSection({
  settings,
  trials,
  keyEpoch,
  busy,
  prompt,
  onChangePrompt,
  onStart,
  onCancel,
  onDelete,
  onDeleteAll,
}: ImageTrialSectionProps) {
  const [showAll, setShowAll] = useState(false);
  const list = trials ?? [];
  const panel = trialPanelState({
    runtimeAvailable: settings.runtimeAvailable,
    configured: settings.configured,
    enabled: settings.enabled,
    synced: true,
    trials: list,
  });
  const running = list.find((trial) => trial.state === "running") ?? null;
  const latest = latestTrial(list);
  const blocked = trialStartBlockedReason({
    runtimeAvailable: settings.runtimeAvailable,
    configured: settings.configured,
    enabled: settings.enabled,
    keyAvailable: settings.keyAvailable,
    running: running !== null,
    prompt,
  });
  const visible = showAll ? list : list.slice(0, HISTORY_PREVIEW_COUNT);

  return (
    <section className="grid min-w-0 gap-2 border-t border-line pt-3">
      <div className="grid gap-0.5">
        <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">設定に反映しない試行</h3>
        <p className="text-2xs leading-relaxed text-ink-muted">
          画面の値で生成だけを試します。モデルの保存値は変えません。送ったプロンプトと結果は履歴に残ります。
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
          onClick={() => void onStart({ kind: "image", model: modelRefOf(settings), prompt })}
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

      {latest ? <ResultCard trial={latest} currentKeyEpoch={keyEpoch} busy={busy} onDelete={onDelete} /> : null}

      {list.length === 0 ? (
        <p className="text-2xs text-ink-faint">まだ試行の履歴はありません。</p>
      ) : (
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">
              履歴（{list.length} 件）
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {list.length > HISTORY_PREVIEW_COUNT ? (
                <button type="button" className="btn-quiet" onClick={() => setShowAll((current) => !current)}>
                  {showAll ? "最新 3 件だけ表示" : "すべて表示"}
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
          <ul className="grid gap-1">
            {visible.map((trial) => (
              <HistoryListItem key={trial.id} row={trialHistoryRow(trial, keyEpoch)} busy={busy} onDelete={onDelete} />
            ))}
          </ul>
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

/** 画像モデルの `provider/id`。カタログ外の保存値でも同じ表記で送る */
function modelRefOf(settings: ContentSettingsResponse): string {
  if (settings.provider === null || settings.image.model === null) return "";
  return `${settings.provider}/${settings.image.model}`;
}

function ResultCard({
  trial,
  currentKeyEpoch,
  busy,
  onDelete,
}: {
  trial: ContentTrial;
  currentKeyEpoch: number;
  busy: boolean;
  onDelete: (id: string) => Promise<boolean>;
}) {
  const row = trialHistoryRow(trial, currentKeyEpoch);
  return (
    <div className="grid gap-1 rounded-lg border border-line bg-soft p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs font-semibold text-ink-strong">最新の試行</span>
        <span className={cn("text-2xs", trial.state === "failed" ? "text-warn" : "text-ink-muted")}>
          {row.stateLabel}
        </span>
        <code className="text-2xs text-ink-ghost">{row.model}</code>
        <span className="text-2xs text-ink-muted">{row.durationLabel}</span>
        {row.keyEpochLabel ? <span className="text-2xs text-warn">{row.keyEpochLabel}</span> : null}
        {trial.recorded ? null : <span className="text-2xs text-warn">状態を記録できませんでした</span>}
      </div>
      {row.failureLabel ? (
        <p className="text-2xs text-warn">
          失敗の分類: {row.failureLabel}
          {trial.failureMessage ? ` — ${trial.failureMessage}` : ""}
        </p>
      ) : null}
      <p className="text-2xs break-words whitespace-pre-wrap text-ink">{row.prompt}</p>
      <p className="text-2xs leading-relaxed text-ink-faint">
        結果は保存されていません（記録のみ）。ダウンロードや再生はまだできません。
      </p>
      <div className="flex flex-wrap items-center gap-2">
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
    </div>
  );
}

function HistoryListItem({
  row,
  busy,
  onDelete,
}: {
  row: TrialHistoryRow;
  busy: boolean;
  onDelete: (id: string) => Promise<boolean>;
}) {
  return (
    <li className="grid gap-0.5 rounded border border-line bg-base px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className={cn("text-2xs", row.state === "failed" ? "text-warn" : "text-ink-muted")}>
          {row.stateLabel}
        </span>
        <code className="min-w-0 truncate text-2xs text-ink-ghost">{row.model}</code>
        <span className="text-2xs text-ink-muted">{row.durationLabel}</span>
        {row.keyEpochLabel ? <span className="text-2xs text-warn">{row.keyEpochLabel}</span> : null}
        <span className="min-w-0 flex-1 truncate text-2xs text-ink" title={row.prompt}>
          {row.prompt}
        </span>
        {row.failureLabel ? <span className="text-2xs text-warn">{row.failureLabel}</span> : null}
        <button
          type="button"
          className="btn-quiet shrink-0"
          disabled={busy || row.state === "running"}
          aria-label={`${row.stateLabel}の試行を削除`}
          onClick={() => void onDelete(row.id)}
        >
          <TrashIcon />
        </button>
      </div>
    </li>
  );
}

/** 証拠の 1 行。モデル選択の直下に置き、緑のバッジにはしない */
export function EvidenceLine({
  trials,
  settings,
  keyEpoch,
  now,
}: {
  trials: readonly ContentTrial[] | null;
  settings: ContentSettingsResponse;
  keyEpoch: number;
  now: number;
}) {
  const evidence = imageTrialEvidence({
    trials: trials ?? [],
    currentKeyEpoch: keyEpoch,
    currentModel: modelRefOf(settings),
    now,
  });
  return (
    <p className="text-2xs leading-relaxed text-ink-muted">
      {evidenceNote(evidence, { now })}
      <span className="text-ink-faint">（チャットの生成は含めません）</span>
    </p>
  );
}
