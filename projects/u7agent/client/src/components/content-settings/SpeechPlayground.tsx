import { useEffect, useRef, useState } from "react";
import {
  speechModelOptions,
  speechPreviewFailureNote,
  speechPreviewFormatNote,
  speechPreviewInitialDraft,
  speechPreviewRequest,
  speechVoiceDraft,
  speechVoiceMode,
  type SpeechPreviewAudio,
  type SpeechPreviewDraft,
} from "../../lib/contentSettings";
import type { ContentSettingsResponse, SpeechPreviewBody } from "../../types";
import { SelectField } from "../SelectField";

export type SpeechPlaygroundProps = {
  settings: ContentSettingsResponse;
  /** お試し再生の要求。signal で画面を離れたときの中断を伝える */
  onPreview: (input: SpeechPreviewBody, signal?: AbortSignal) => Promise<SpeechPreviewAudio>;
};

/** 生成した音声と、再生に使う blob URL。URL はこの画面が作って解放する */
type SpeechPreviewPlayback = SpeechPreviewAudio & { url: string };

/**
 * 音声セクションの「お試し再生」。保存した設定は変えず、この場で選んだ値で 1 回だけ鳴らす。
 * モデルとボイスは保存値を初期値にし、未保存の選択をそのまま試せる（同期できていない間も使える）。
 */
export function SpeechPlayground({ settings, onPreview }: SpeechPlaygroundProps) {
  // null は保存値へ追随する。この画面で選び直したら、保存が変わってもその値を試し続ける
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftVoice, setDraftVoice] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [instructions, setInstructions] = useState("");
  const [speed, setSpeed] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audio, setAudio] = useState<SpeechPreviewPlayback | null>(null);
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
  const values: SpeechPreviewDraft = { model, voice, text, instructions, speed };

  // blob: の URL はこの画面が持ち、再生成と離脱で解放する（作り直すたびに前の URL を捨てる）
  useEffect(() => {
    if (!audio) return;
    return () => URL.revokeObjectURL(audio.url);
  }, [audio]);
  useEffect(() => () => controller.current?.abort(), []);

  const submit = async () => {
    const request = speechPreviewRequest(values);
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
      const result = await onPreview(request.body, next.signal);
      if (next.signal.aborted) return;
      setAudio({ blob: result.blob, url: URL.createObjectURL(result.blob), format: result.format });
    } catch (caught) {
      if (next.signal.aborted) return;
      setError(speechPreviewFailureNote(caught));
    } finally {
      // 中断（離脱 / 新しい要求）のときは state を触らない
      if (controller.current === next && !next.signal.aborted) setBusy(false);
    }
  };

  return (
    <SpeechPlaygroundView
      settings={settings}
      values={values}
      busy={busy}
      error={error}
      audio={audio}
      onChange={(patch) => {
        if (patch.model !== undefined) {
          setDraftModel(patch.model);
          // モデルを切り替えたら、ボイスは新しいモデルの既定（先頭、宣言が無ければ空）へ寄せる
          setDraftVoice(null);
        }
        if (patch.voice !== undefined) setDraftVoice(patch.voice);
        if (patch.text !== undefined) setText(patch.text);
        if (patch.instructions !== undefined) setInstructions(patch.instructions);
        if (patch.speed !== undefined) setSpeed(patch.speed);
      }}
      onSubmit={() => void submit()}
    />
  );
}

/** お試し再生の描画だけを持つ部分。生成中 / 失敗 / 形式の表示を SSR でも検査できるように分ける */
export function SpeechPlaygroundView({
  settings,
  values,
  busy,
  error,
  audio,
  onChange,
  onSubmit,
}: {
  settings: ContentSettingsResponse;
  values: SpeechPreviewDraft;
  busy: boolean;
  error: string | null;
  audio: SpeechPreviewPlayback | null;
  onChange: (patch: Partial<SpeechPreviewDraft>) => void;
  onSubmit: () => void;
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
        保存した設定は変えずに、この場で試しに鳴らせます。1 回の再生ごとに provider
        のクレジットを消費します。演技指示と速度は未対応のモデルでは無視されるか 400 になります。
      </p>
      {runtimeAvailable ? null : (
        <p role="alert" className="rounded-lg border border-warn/40 bg-raised px-2.5 py-2 text-2xs text-warn">
          ランタイムが利用できないため、お試し再生はできません。サーバーの起動ログを確認してください。
        </p>
      )}
      <textarea
        className="field min-h-16 min-w-0 resize-y text-xs"
        value={values.text}
        aria-label="お試し再生の本文"
        placeholder="読み上げる文章（演技指示は下の欄へ）"
        disabled={busy}
        onChange={(event) => onChange({ text: event.currentTarget.value })}
      />
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
            {(selectedOption?.model?.voices ?? []).map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </SelectField>
        )}
      </div>
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
        <input
          className="field w-28 text-xs"
          value={values.speed}
          aria-label="お試し再生の速度"
          placeholder="速度（任意）"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => onChange({ speed: event.currentTarget.value })}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary" disabled={busy || !runtimeAvailable} onClick={onSubmit}>
          {busy ? "生成中…" : "再生"}
        </button>
        {busy ? <span className="text-2xs text-ink-muted">音声を生成しています…</span> : null}
      </div>
      {error === null ? null : (
        <p role="alert" className="rounded-lg border border-warn/40 bg-raised px-2.5 py-2 text-2xs text-warn">
          {error}
        </p>
      )}
      {audio === null ? null : (
        <div className="grid gap-1">
          {/* blob: の URL はこの画面が持ち、再生成と離脱で revoke する（本番 CSP の media-src に blob: が要る） */}
          <audio controls src={audio.url} className="w-full" />
          <p className="text-2xs text-ink-muted">{speechPreviewFormatNote(audio.format)}</p>
        </div>
      )}
    </section>
  );
}
