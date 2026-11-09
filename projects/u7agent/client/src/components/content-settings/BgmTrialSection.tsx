import { useEffect, useState } from "react";
import {
  BGM_TRIAL_PROMPT_MAX_LENGTH,
  bgmDurationLabel,
  bgmTrialRequest,
  hasStoredArtifact,
  latestTrial,
  trialArtifactSummary,
  trialArtifactUrl,
  trialHistoryRow,
  trialPanelState,
  trialStartBlockedReason,
} from "../../lib/contentTrials";
import type { ContentSettingsResponse, ContentTrial, ContentTrialSummary, CreateContentTrialBody } from "../../types";
import { TrialArtifactMeta, TrialResultViewport } from "./TrialResultViewport";
import { TrialEmptyNote, TrialNoteLines, TrialRunControls, TrialRunSection } from "./TrialRun";

export type BgmTrialSectionProps = {
  settings: ContentSettingsResponse;
  /** 固定モデル。未設定では空文字（開始は `trialStartBlockedReason` が止める） */
  model: string;
  /** 一覧は要約（本文は抜粋）。直近の行の全文は `onLoadTrial` で取る */
  trials: readonly ContentTrialSummary[] | null;
  keyEpoch: number;
  note: { text: string; error: boolean } | null;
  busy: boolean;
  /** プロンプトの下書き。面を切り替えても失わないよう、呼び出し側が持つ */
  prompt: string;
  onChangePrompt: (prompt: string) => void;
  onStart: (input: CreateContentTrialBody) => Promise<boolean>;
  onCancel: (id: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  /** 直近の行の全文を取る（プロンプトの全文表示に使う） */
  onLoadTrial: (id: string) => Promise<ContentTrial | null>;
};

/**
 * 設定に反映しない BGM の試行。モデルは固定なので選択肢を持たず、プロンプトを 1 回送って
 * 直近の結果だけを同じ面に出す。履歴は専用のタブ（`TrialHistoryTab`）が全種別をまとめて見る。
 */
export function BgmTrialSection({
  settings,
  model,
  trials,
  keyEpoch,
  note,
  busy,
  prompt,
  onChangePrompt,
  onStart,
  onCancel,
  onDelete,
  onLoadTrial,
}: BgmTrialSectionProps) {
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
  const latest = latestTrial(list);
  const latestId = latest?.id ?? null;
  // 一覧は抜粋しか持たないため、直近の行の全文を取る。行が変わったら前の全文を残さない
  const [latestDetail, setLatestDetail] = useState<ContentTrial | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (latestId === null) {
      setLatestDetail(null);
      return;
    }
    void onLoadTrial(latestId).then((trial) => {
      if (!cancelled) setLatestDetail(trial);
    });
    return () => {
      cancelled = true;
    };
  }, [latestId, onLoadTrial]);
  const blocked = trialStartBlockedReason({
    runtimeAvailable: settings.runtimeAvailable,
    configured: settings.configured,
    enabled: settings.enabled,
    keyAvailable: settings.keyAvailable,
    running: running !== null,
    prompt,
    emptyPromptReason: "BGM のプロンプトを入力してください",
  });

  /** 検証を通ったときだけ要求を出し、開始できたかを返す */
  const start = async (value: string): Promise<boolean> => {
    const request = bgmTrialRequest({ prompt: value, model, origin: "form" });
    if (!request.ok) {
      setInputError(request.error);
      return false;
    }
    setInputError(null);
    return onStart(request.input);
  };

  return (
    <TrialRunSection description="固定モデルで生成だけを試します。保存する設定はありません。送ったプロンプトと結果はアプリのデータ領域に履歴として残ります（時間ベースでは消えません）。">
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
        onStart={() => void start(prompt)}
        onCancel={() => {
          if (running) void onCancel(running.id);
        }}
      />

      <TrialNoteLines alert={inputError} note={note} />

      {latest === null ? (
        <TrialEmptyNote />
      ) : (
        <BgmResultViewport
          // 実測の尺は選んだ試行ごとに読み直す（前の行の秒数を残さない）
          key={latest.id}
          trial={latest}
          detail={latestDetail}
          currentKeyEpoch={keyEpoch}
          busy={busy}
          running={running !== null}
          expectedDurationSeconds={settings.bgm.expectedDurationSeconds}
          onDelete={onDelete}
        />
      )}
    </TrialRunSection>
  );
}

/**
 * 直近の BGM の結果。実測の尺は `<audio>` のメタデータから読み、読めるまでは `—` にする
 * （目安尺と混ぜない）。
 */
function BgmResultViewport({
  trial,
  detail,
  currentKeyEpoch,
  busy,
  running,
  expectedDurationSeconds,
  onDelete,
}: {
  trial: ContentTrialSummary;
  /** 直近の行の全文。取得中は null で、本文は抜粋を出す */
  detail: ContentTrial | null;
  currentKeyEpoch: number;
  busy: boolean;
  running: boolean;
  expectedDurationSeconds: number;
  onDelete: (id: string) => Promise<boolean>;
}) {
  const [measured, setMeasured] = useState<number | null>(null);

  return (
    <TrialResultViewport
      trial={trial}
      currentKeyEpoch={currentKeyEpoch}
      busy={busy}
      running={running}
      sentNoun="プロンプト"
      variant="latest"
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
      promptComplete={detail !== null}
      onDelete={onDelete}
    />
  );
}
