import { useEffect, useRef, useState, type RefObject } from "react";
import {
  SPEECH_PREVIEW_SPEED_STEP,
  speechModelOptions,
  speechPreviewDefaultText,
  speechPreviewFailureNote,
  speechPreviewFormatNote,
  speechPreviewInitialDraft,
  speechPreviewPrimaryAction,
  speechPreviewRequest,
  speechPreviewSpeedStep,
  speechVoiceDraft,
  speechVoiceMode,
  type SpeechPreviewAudio,
  type SpeechPreviewDraft,
} from "../../lib/contentSettings";
import type { ContentSettingsResponse, SpeechPreviewBody } from "../../types";
import { MinusIcon, PlusIcon } from "../icons";
import { SelectField } from "../SelectField";
import { SpeechVoiceOptions } from "./SpeechVoiceOptions";

export type SpeechPlaygroundProps = {
  settings: ContentSettingsResponse;
  /** お試し再生の要求。signal で画面を離れたときの中断を伝える */
  onPreview: (input: SpeechPreviewBody, signal?: AbortSignal) => Promise<SpeechPreviewAudio>;
};

/** 生成した音声と、再生に使う blob URL。URL はこの画面が作って解放する */
type SpeechPreviewPlayback = SpeechPreviewAudio & { url: string };

/** いま表示している音声と、それを作った要求。生成に成功したときだけ入れ替える（食い違いを型で作れなくする） */
type SpeechPreviewResult = { body: SpeechPreviewBody; audio: SpeechPreviewPlayback };

/**
 * 音声セクションの「お試し再生」。保存した設定は変えず、この場で選んだ値で 1 回だけ鳴らす。
 * モデルとボイスは保存値を初期値にし、未保存の選択をそのまま試せる（同期できていない間も使える）。
 */
export function SpeechPlayground({ settings, onPreview }: SpeechPlaygroundProps) {
  // null は保存値へ追随する。この画面で選び直したら、保存が変わってもその値を試し続ける
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftVoice, setDraftVoice] = useState<string | null>(null);
  // null はテンプレへ追随する。1 文字でも打ったら（空にした場合も）その値で固定する
  const [draftText, setDraftText] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [speed, setSpeed] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SpeechPreviewResult | null>(null);
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const controller = useRef<AbortController | null>(null);

  const initial = speechPreviewInitialDraft(settings);
  const options = speechModelOptions(settings);
  const model = draftModel ?? initial.model;
  const selectedOption = options.find((option) => option.value === model);
  const voice = speechVoiceDraft({
    draft: draftVoice,
    modelChanged: draftModel !== null,
    option: selectedOption,
    savedVoice: initial.voice,
  });
  const values: SpeechPreviewDraft = {
    model,
    voice,
    text: draftText ?? speechPreviewDefaultText(selectedOption?.model),
    instructions,
    speed,
  };
  const request = speechPreviewRequest(values);
  const primary = speechPreviewPrimaryAction({
    busy,
    body: request.ok ? request.body : null,
    lastBody: result?.body ?? null,
  });

  // blob: の URL はこの画面が持ち、再生成と離脱で解放する（作り直すたびに前の URL を捨てる）
  useEffect(() => {
    if (!result) return;
    return () => URL.revokeObjectURL(result.audio.url);
  }, [result]);
  useEffect(() => () => controller.current?.abort(), []);

  const submit = async () => {
    if (!request.ok) {
      setError(request.error);
      return;
    }
    // 前の要求が残っていれば中断し、古い応答で表示を上書きしない
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setBusy(true);
    setError(null);
    try {
      const audio = await onPreview(request.body, next.signal);
      if (next.signal.aborted) return;
      setResult({ body: request.body, audio: { ...audio, url: URL.createObjectURL(audio.blob) } });
    } catch (caught) {
      if (next.signal.aborted) return;
      setError(speechPreviewFailureNote(caught));
    } finally {
      // 中断（離脱 / 新しい要求）のときは state を触らない
      if (controller.current === next && !next.signal.aborted) setBusy(false);
    }
  };

  // 押下起点なので自動再生ポリシーに掛かりにくい。鳴らせないときの reject（中断 / src の差し替えによる
  // AbortError を含む）は握り、プレイヤーの ▶ を保険にする（再生できない理由の UI を持たないのは既存のプレビューと同じ）。
  const replay = () => {
    const player = playerRef.current;
    if (!player) return;
    player.currentTime = 0;
    void player.play().catch(() => {});
  };

  return (
    <SpeechPlaygroundView
      settings={settings}
      values={values}
      busy={busy}
      error={error}
      result={result}
      playerRef={playerRef}
      replayable={primary.replayable}
      primaryLabel={primary.label}
      onChange={(patch) => {
        if (patch.model !== undefined) {
          setDraftModel(patch.model);
          // モデルを切り替えたら、ボイスは新しいモデルの既定（先頭、宣言が無ければ空）へ寄せる
          setDraftVoice(null);
        }
        if (patch.voice !== undefined) setDraftVoice(patch.voice);
        if (patch.text !== undefined) setDraftText(patch.text);
        if (patch.instructions !== undefined) setInstructions(patch.instructions);
        if (patch.speed !== undefined) setSpeed(patch.speed);
      }}
      onSubmit={() => void submit()}
      onReplay={replay}
    />
  );
}

/** お試し再生の描画だけを持つ部分。生成中 / 失敗 / 形式の表示を SSR でも検査できるように分ける */
export function SpeechPlaygroundView({
  settings,
  values,
  busy,
  error,
  result,
  playerRef,
  replayable,
  primaryLabel,
  onChange,
  onSubmit,
  onReplay,
}: {
  settings: ContentSettingsResponse;
  values: SpeechPreviewDraft;
  busy: boolean;
  error: string | null;
  result: SpeechPreviewResult | null;
  /** 押下で鳴らす `<audio>`。再生そのものは保持側が持ち、ここは ref を付けて描くだけにする */
  playerRef: RefObject<HTMLAudioElement | null>;
  replayable: boolean;
  primaryLabel: string;
  onChange: (patch: Partial<SpeechPreviewDraft>) => void;
  onSubmit: () => void;
  onReplay: () => void;
}) {
  const options = speechModelOptions(settings);
  const selectedOption = options.find((option) => option.value === values.model);
  const textMode = speechVoiceMode(selectedOption) === "text";
  // 生成器はランタイムが持つため、runtime 不可では押しても必ず 503 になる（未同期とは別のゲート）
  const runtimeAvailable = settings.runtimeAvailable;

  return (
    <section className="grid gap-1.5 border-t border-line pt-3">
      <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">お試し再生</div>
      <p className="text-2xs leading-relaxed text-ink-muted">
        保存した設定は変えずに、この場で試しに鳴らせます。生成は 1 回ごとに provider
        のクレジットを消費しますが、入力が同じ間の押下は再生だけになり課金されません。演技指示と速度は
        未対応のモデルでは無視されるか 400 になります。
      </p>
      {runtimeAvailable ? null : (
        <p role="alert" className="rounded-lg border border-warn/40 bg-raised px-2.5 py-2 text-2xs text-warn">
          ランタイムが利用できないため、お試し再生はできません。サーバーの起動ログを確認してください。
        </p>
      )}
      {/* 保存フォームと同じ順（モデル → ボイス → 本文 → 演技指示）で読めるようにする */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <SelectField
          wrapperClassName="min-w-0 flex-1"
          aria-label="お試し再生のモデル"
          value={values.model}
          disabled={busy}
          onChange={(event) => onChange({ model: event.currentTarget.value })}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {textMode ? (
          <input
            className="field min-w-0 flex-1 text-xs"
            value={values.voice}
            aria-label="お試し再生のボイス"
            placeholder="モデル既定（空欄のまま送ります）"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => onChange({ voice: event.currentTarget.value })}
          />
        ) : (
          <SelectField
            wrapperClassName="min-w-0 flex-1"
            aria-label="お試し再生のボイス"
            value={values.voice}
            disabled={busy}
            onChange={(event) => onChange({ voice: event.currentTarget.value })}
          >
            <SpeechVoiceOptions modelId={values.model} voices={selectedOption?.model?.voices} />
          </SelectField>
        )}
      </div>
      <textarea
        className="field min-h-16 min-w-0 resize-y text-xs"
        value={values.text}
        aria-label="お試し再生の本文"
        placeholder="読み上げる文章（演技指示は下の欄へ）"
        disabled={busy}
        onChange={(event) => onChange({ text: event.currentTarget.value })}
      />
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input
          className="field min-w-0 flex-1 text-xs"
          value={values.instructions}
          aria-label="お試し再生の演技指示"
          placeholder="演技指示（任意）"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => onChange({ instructions: event.currentTarget.value })}
        />
        {/* 空欄は「送らない」（provider の既定）。増減は押下だけで完結させ、欄は今までどおり手入力も受ける */}
        <div className="flex items-center gap-1">
          <span className="text-2xs text-ink-faint">速度</span>
          <button
            type="button"
            className="icon-button"
            aria-label={`速度を ${SPEECH_PREVIEW_SPEED_STEP} 下げる`}
            disabled={busy}
            onClick={() => onChange({ speed: speechPreviewSpeedStep(values.speed, -SPEECH_PREVIEW_SPEED_STEP) })}
          >
            <MinusIcon />
          </button>
          <input
            className="field w-16 text-center text-xs"
            value={values.speed}
            aria-label="お試し再生の速度"
            placeholder="既定"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => onChange({ speed: event.currentTarget.value })}
          />
          <button
            type="button"
            className="icon-button"
            aria-label={`速度を ${SPEECH_PREVIEW_SPEED_STEP} 上げる`}
            disabled={busy}
            onClick={() => onChange({ speed: speechPreviewSpeedStep(values.speed, SPEECH_PREVIEW_SPEED_STEP) })}
          >
            <PlusIcon />
          </button>
        </div>
      </div>
      {/* 単位と基準値は欄の外に常時出す（placeholder は入力と同時に消えて手掛かりが無くなる） */}
      <p className="text-2xs leading-relaxed text-ink-faint">
        速度は <span className="text-ink-soft">1.0 が標準</span>（倍率）。0.8 で遅く、1.2
        で速く。空欄はモデル既定。対応範囲はモデルにより異なります。
        {values.speed.trim() === "" ? null : (
          <button
            type="button"
            className="text-accent-text underline underline-offset-2 disabled:opacity-45"
            disabled={busy}
            onClick={() => onChange({ speed: "" })}
          >
            既定に戻す
          </button>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || !runtimeAvailable}
          onClick={() => (replayable ? onReplay() : onSubmit())}
        >
          {primaryLabel}
        </button>
        {busy ? <span className="text-2xs text-ink-muted">音声を生成しています…</span> : null}
      </div>
      {error === null ? null : (
        <p role="alert" className="rounded-lg border border-warn/40 bg-raised px-2.5 py-2 text-2xs text-warn">
          {error}
        </p>
      )}
      {result === null ? null : (
        <div className="grid gap-1">
          {/* blob: の URL はこの画面が持ち、再生成と離脱で revoke する（本番 CSP の media-src に blob: が要る） */}
          <audio ref={playerRef} controls src={result.audio.url} className="w-full" />
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-2xs text-ink-muted">{speechPreviewFormatNote(result.audio.format)}</p>
            {/* 同じ入力でも出力は毎回同じとは限らないため、再生のときだけ別テイクへ行ける導線を残す */}
            {replayable ? (
              <button type="button" className="btn-quiet" disabled={busy || !runtimeAvailable} onClick={onSubmit}>
                別のテイクを生成
              </button>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
