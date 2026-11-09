import { useEffect, useState } from "react";
import {
  hasStoredArtifact,
  latestTrial,
  speechTrialRequest,
  speechTrialSnapshotLabels,
  trialArtifactSummary,
  trialArtifactUrl,
  trialHistoryRow,
  trialPanelState,
  trialStartBlockedReason,
  type SpeechTrialDraft,
} from "../../lib/contentTrials";
import { SPEECH_SPEED_MIN, SPEECH_SPEED_STEP, speechSpeedStep } from "../../lib/contentSettings";
import { speechTrialDefaultTarget } from "../../lib/trialDefault";
import type {
  ContentSettingsResponse,
  ContentTrial,
  ContentTrialSummary,
  CreateContentTrialBody,
  UpdateContentSpeechBody,
} from "../../types";
import { MinusIcon, PlusIcon } from "../icons";
import { TrialArtifactMeta, TrialResultViewport } from "./TrialResultViewport";
import { TrialEmptyNote, TrialNoteLines, TrialRunControls, TrialRunSection } from "./TrialRun";
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
  /** 一覧は要約（本文は抜粋）。直近の行の全文は `onLoadTrial` で取る */
  trials: readonly ContentTrialSummary[] | null;
  keyEpoch: number;
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
  /** 直近の行の全文を取る（本文・演技指示・話速の全文表示に使う） */
  onLoadTrial: (id: string) => Promise<ContentTrial | null>;
};

/**
 * 設定に反映しない音声の試行。本文・演技指示・話速を 1 回送り、直近の結果だけを同じ面に出す。
 * 履歴は専用のタブ（`TrialHistoryTab`）が全種別をまとめて見る。
 */
export function SpeechTrialSection({
  settings,
  model,
  voice,
  trials,
  keyEpoch,
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
  onLoadTrial,
}: SpeechTrialSectionProps) {
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
  // 同じ組み合わせを保存しても何も変わらないため、結果との差分があるときだけ導線を出す
  const defaultTarget = latest
    ? speechTrialDefaultTarget({ settings, trialModel: latest.model, trialVoice: latest.voice })
    : null;
  // 保存フォームと同じゲート。直近の結果は未設定・未同期でも読めるが、同じ PUT を呼ぶ保存は止める
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
  const stored = latest !== null && hasStoredArtifact(latest);
  // 演技指示は長いので一覧に載らない。全文を取れるまでは「読み込み中」と出す（指定なしと混同しない）
  const snapshot = latestDetail === null ? null : speechTrialSnapshotLabels(latestDetail);
  const speedLabel = latest?.speed === null || latest?.speed === undefined ? "モデル既定" : `${latest.speed} 倍`;

  /** 検証を通ったときだけ要求を出し、開始できたかを返す */
  const start = async (values: SpeechTrialDraft): Promise<boolean> => {
    const request = speechTrialRequest({ draft: values, model, voice, origin: "form" });
    if (!request.ok) {
      setInputError(request.error);
      return false;
    }
    setInputError(null);
    return onStart(request.input);
  };

  return (
    <TrialRunSection description="画面の値で生成だけを試します。モデルとボイスの保存値は変えません。送った本文・演技指示・話速と結果はアプリのデータ領域に履歴として残ります（時間ベースでは消えません）。">
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
        onStart={() => void start(draft)}
        onCancel={() => {
          if (running) void onCancel(running.id);
        }}
      />

      <TrialNoteLines alert={inputError} note={note} />

      {latest === null ? (
        <TrialEmptyNote />
      ) : (
        <TrialResultViewport
          trial={latest}
          currentKeyEpoch={keyEpoch}
          busy={busy}
          running={running !== null}
          sentNoun="本文"
          variant="latest"
          chips={[`ボイス: ${latest.voice ?? "モデル既定"}`]}
          artifact={
            stored ? (
              <div className="grid gap-1">
                <audio controls src={trialArtifactUrl(latest.id)} aria-label="試行の音声" className="w-full" />
                <TrialArtifactMeta trialId={latest.id} label={trialArtifactSummary(latest)} />
              </div>
            ) : null
          }
          prompt={latestDetail?.prompt ?? trialHistoryRow(latest, keyEpoch).promptPreview}
          promptComplete={latestDetail !== null}
          promptDetail={`演技指示: ${snapshot?.instructions ?? "読み込み中…"} · 話速: ${snapshot?.speed ?? speedLabel}`}
          defaultAction={
            <TrialDefaultAction
              key={latest.id}
              label="このモデルとボイスを既定にする"
              target={defaultTarget}
              disabled={busy || settingsBusy}
              blockedReason={defaultBlockedReason}
              onSave={onMakeDefault}
            />
          }
          onDelete={onDelete}
        />
      )}
    </TrialRunSection>
  );
}
