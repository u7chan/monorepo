import { useEffect, useState } from "react";
import {
  evidenceNote,
  hasStoredArtifact,
  imageTrialProviderBlockedReason,
  imageTrialRequest,
  latestTrial,
  trialArtifactSummary,
  trialArtifactUrl,
  trialDimensionLabel,
  trialEvidence,
  trialHistoryRow,
  trialPanelState,
  trialStartBlockedReason,
} from "../../lib/contentTrials";
import { imageTrialDefaultTarget } from "../../lib/trialDefault";
import type {
  ContentSettingsResponse,
  ContentTrial,
  ContentTrialSummary,
  CreateContentTrialBody,
  UpdateContentImageBody,
} from "../../types";
import { ZoomableImage } from "../ImageZoom";
import { TrialArtifactMeta, TrialResultViewport } from "./TrialResultViewport";
import { TrialEmptyNote, TrialNoteLines, TrialRunControls, TrialRunSection } from "./TrialRun";
import { TrialDefaultAction, UNCONFIGURED_BLOCKED_NOTE } from "./TrialDefaultAction";

export type ImageTrialSectionProps = {
  settings: ContentSettingsResponse;
  /** 画面で選択中のモデル（下書き優先）。保存前でも画面の値で試行する */
  model: string;
  /** 一覧は要約（本文は抜粋）。直近の行の全文は `onLoadTrial` で取る */
  trials: readonly ContentTrialSummary[] | null;
  /** 現在のキー世代。証拠と「旧キー」の判定に使う */
  keyEpoch: number;
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
  /** 直近の行の全文を取る（プロンプトの全文表示に使う） */
  onLoadTrial: (id: string) => Promise<ContentTrial | null>;
};

/**
 * 設定に反映しない画像の試行。プロンプトを 1 回送り、直近の結果だけを同じ面に出す。
 * 履歴は専用のタブ（`TrialHistoryTab`）が全種別をまとめて見る。
 * キー未設定・全体 OFF・runtime 不可でも直近の結果は読み、新規生成だけを止める。
 */
export function ImageTrialSection({
  settings,
  model,
  trials,
  keyEpoch,
  note,
  busy,
  settingsBusy,
  onMakeDefault,
  prompt,
  onChangePrompt,
  onStart,
  onCancel,
  onDelete,
  onLoadTrial,
}: ImageTrialSectionProps) {
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
    // 行が変わった直後に前の行の全文を新しい行のものとして出さない（取れるまでは抜粋）
    setLatestDetail(null);
    void onLoadTrial(latestId).then((trial) => {
      if (!cancelled) setLatestDetail(trial);
    });
    return () => {
      cancelled = true;
    };
  }, [latestId, onLoadTrial]);
  // 同じモデルを保存しても何も変わらないため、結果との差分があるときだけ導線を出す
  const defaultTarget = latest ? imageTrialDefaultTarget({ settings, trialModel: latest.model }) : null;
  const defaultBlockedReason = settings.configured ? null : UNCONFIGURED_BLOCKED_NOTE;
  const providerBlocked = imageTrialProviderBlockedReason(settings.image.provider);
  const blocked = trialStartBlockedReason({
    runtimeAvailable: settings.runtimeAvailable,
    configured: settings.configured,
    enabled: settings.enabled,
    keyAvailable: settings.keyAvailable,
    running: running !== null,
    prompt,
    providerBlockedReason: providerBlocked,
  });
  const stored = latest !== null && hasStoredArtifact(latest);

  return (
    <TrialRunSection description="画面の値で生成だけを試します。モデルの保存値は変えません。送ったプロンプトと結果はアプリのデータ領域に履歴として残ります（時間ベースでは消えません）。">
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

      {providerBlocked === null ? null : (
        <p
          role="status"
          className="rounded border border-line bg-base px-2 py-1.5 text-2xs leading-relaxed text-ink-muted"
        >
          {providerBlocked}
        </p>
      )}

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

      {latest === null ? (
        <TrialEmptyNote />
      ) : (
        <TrialResultViewport
          trial={latest}
          currentKeyEpoch={keyEpoch}
          busy={busy}
          running={running !== null}
          sentNoun="プロンプト"
          variant="latest"
          artifact={
            stored ? (
              <div className="grid gap-1">
                {/* 拡大は会話の画像と同じ dialog に任せる（同じ寸法規則を 2 か所に増やさない） */}
                <ZoomableImage src={trialArtifactUrl(latest.id)} alt="試行の結果" variant="attachment" checker />
                <TrialArtifactMeta trialId={latest.id} label={trialArtifactSummary(latest)}>
                  {trialDimensionLabel(latest) ? null : (
                    <p className="text-2xs text-ink-faint">実寸を読めませんでした。</p>
                  )}
                </TrialArtifactMeta>
              </div>
            ) : null
          }
          prompt={latestDetail?.prompt ?? trialHistoryRow(latest, keyEpoch).promptPreview}
          promptComplete={latestDetail !== null}
          defaultAction={
            <TrialDefaultAction
              key={latest.id}
              label="このモデルを既定にする"
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
  return (
    <p className="text-2xs leading-relaxed text-ink-muted">
      {evidenceNote(
        trialEvidence({
          trials: trials ?? [],
          currentKeyEpoch: keyEpoch,
          currentModel: model,
          ...(voice === undefined ? {} : { currentVoice: voice }),
          now,
        }),
        { now },
      )}
      <span className="text-ink-faint">（チャットの生成は含めません）</span>
    </p>
  );
}
