import { useState } from "react";
import {
  formatVoiceInputMs,
  formatVoiceInputSeconds,
  voiceInputFailureLabel,
  voiceInputPlaygroundBusy,
  voiceInputPlaygroundCanStop,
  voiceInputPlaygroundStatus,
  type VoiceInputPlaygroundState,
} from "../../lib/voiceInput/playground";
import { VOICE_INPUT_MAX_SECONDS } from "../../lib/voiceInput/session";
import { VOICE_INPUT_DEADLINE_LIMITATION, voiceInputPlaygroundNotice } from "../../lib/voiceInputSettings";

export type VoiceInputPlaygroundProps = {
  /** 固定モデル。送信先を面の上で伝える */
  model: string;
  /** 開始できない理由。undefined なら録音を始められる */
  disabledReason: string | undefined;
  /** 期限後にフレームを落とせるブラウザか。false なら既知の制限を出す */
  frameDeadlineSupported: boolean;
  state: VoiceInputPlaygroundState;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
};

/**
 * 設定 → 音声入力のプレイグラウンド。話した音声の途中表示と確定テキスト、秒数と失敗の分類だけを出し、
 * 音声も文字起こしも保存しない（履歴を持たない）。入力欄への挿入は行わない。
 * 閉じると録音を中止し、面の中の途中・確定テキストも捨てる。
 */
export function VoiceInputPlayground({
  model,
  disabledReason,
  frameDeadlineSupported,
  state,
  onStart,
  onStop,
  onCancel,
}: VoiceInputPlaygroundProps) {
  const [open, setOpen] = useState(true);
  const busy = voiceInputPlaygroundBusy(state);
  const canStop = voiceInputPlaygroundCanStop(state);
  const close = (): void => {
    onCancel();
    setOpen(false);
  };

  return (
    <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">プレイグラウンド</div>
          <p className="mt-0.5 text-xs text-ink">実際に話して、途中表示と確定テキストを確かめます。</p>
        </div>
        <button
          type="button"
          className="btn-quiet"
          aria-expanded={open}
          aria-controls="voice-input-playground"
          onClick={open ? close : () => setOpen(true)}
        >
          {open ? "閉じる" : "開く"}
        </button>
      </div>

      {/* 話す前に、外へ出る・課金されうる・保存しないを読める位置へ置く */}
      <p className="text-2xs leading-relaxed text-ink-muted">{voiceInputPlaygroundNotice(model)}</p>

      {open ? (
        <div id="voice-input-playground" className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={disabledReason !== undefined || busy}
              onClick={onStart}
            >
              {state.phase === "done" || state.phase === "error" ? "もう一度録音" : "録音を開始"}
            </button>
            {busy ? (
              <>
                <button type="button" className="btn-quiet" disabled={!canStop} onClick={onStop}>
                  停止して確定
                </button>
                <button type="button" className="btn-quiet" onClick={onCancel}>
                  中止
                </button>
              </>
            ) : null}
            <p role="status" className="min-w-0 flex-1 text-2xs leading-relaxed text-ink-muted">
              {voiceInputPlaygroundStatus(state)}
            </p>
          </div>

          {disabledReason === undefined ? null : (
            <p role="status" className="text-2xs leading-relaxed text-ink-muted">
              {disabledReason}
            </p>
          )}

          <div className="grid gap-1">
            <div className="text-2xs text-ink-muted">途中の文字起こし（読み取り専用）</div>
            <p className="min-h-6 rounded-lg border border-line bg-raised px-2.5 py-2 text-xs break-words whitespace-pre-wrap text-ink-strong">
              {state.partial === "" ? "（まだ途中の文字はありません）" : state.partial}
            </p>
          </div>

          {/* 確定テキストは読取専用。保存も送信もしないので、ここから先の操作は無い */}
          <label className="grid min-w-0 gap-1">
            <span className="text-2xs text-ink-muted">確定テキスト（読取専用・保存しません）</span>
            <textarea
              className="field min-h-16 min-w-0 resize-y text-xs"
              value={state.transcript}
              rows={3}
              readOnly
              spellCheck={false}
              placeholder="確定したテキストがここに出ます。"
              aria-label="確定した文字起こし（読取専用）"
            />
          </label>

          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-2xs">
            <dt className="text-ink-muted">録音秒数</dt>
            <dd className="text-ink-strong">{formatVoiceInputSeconds(state.recordedSeconds)}</dd>
            <dt className="text-ink-muted">最初の途中表示まで</dt>
            <dd className="text-ink-strong">{formatVoiceInputMs(state.firstPartialMs)}</dd>
            <dt className="text-ink-muted">停止から確定まで</dt>
            <dd className="text-ink-strong">{formatVoiceInputMs(state.stopToFinalMs)}</dd>
          </dl>
          <p className="text-2xs leading-relaxed text-ink-muted">
            最初の途中表示は録音の開始から数えます（発話の検出時刻ではありません）。停止から確定までは、末尾の音声が届くのを待つ時間を含みます。
          </p>

          {state.failure === null ? null : (
            <p role="alert" className="text-2xs leading-relaxed break-words text-warn">
              <span className="font-semibold">{voiceInputFailureLabel(state.failure.code)}</span>：
              {state.failure.message}
            </p>
          )}

          {frameDeadlineSupported ? null : (
            <p className="text-2xs leading-relaxed text-warn">{VOICE_INPUT_DEADLINE_LIMITATION}</p>
          )}

          <p className="text-2xs leading-relaxed text-ink-muted">
            録音はこの画面を開いている間だけ動きます。閉じる・設定を離れる・タブを閉じると中止し、最大{" "}
            {VOICE_INPUT_MAX_SECONDS} 秒で自動停止します。
          </p>
        </div>
      ) : null}
    </section>
  );
}
