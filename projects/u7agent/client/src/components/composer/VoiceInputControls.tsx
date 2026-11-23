import { cn } from "../../lib/cn";
import { VOICE_INPUT_MAX_SECONDS } from "../../lib/voiceInput/session";
import { CloseIcon, MicrophoneIcon, RunSpinnerIcon } from "../icons";

/**
 * 入力欄の行に出す音声の操作。待機中はマイク、操作中は主スロットを占有する 3 種類（取消 / 録音停止 ● /
 * 確定待ち）を出す。大きさは送信・停止と同じ円に揃え、押す位置が入れ替わっても寸法を動かさない。
 */

/** 主スロットの円。送信 ↑ / 停止 ■ と同じ寸法 */
const slotClass = (singleColumn: boolean): string => (singleColumn ? "size-9" : "size-8");

/** マイク。待機中だけ出し、旧・添付ボタンの位置と見た目（円形・枠）と大きさを引き継ぐ */
export function VoiceInputStartButton({ singleColumn, onClick }: { singleColumn: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="音声入力を開始"
      title={`音声入力を開始（最大 ${VOICE_INPUT_MAX_SECONDS} 秒）`}
      onClick={onClick}
      className={cn(
        "grid shrink-0 cursor-pointer place-items-center rounded-full border border-line text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text",
        singleColumn ? "size-9" : "size-8",
      )}
    >
      <MicrophoneIcon />
    </button>
  );
}

/** 接続中。まだ音声は送っていないので、押すと録音を始めずに接続を捨てる */
export function VoiceInputCancelButton({ singleColumn, onClick }: { singleColumn: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="音声入力を取消"
      title="接続をやめて録音を始めません"
      onClick={onClick}
      className={cn(
        "grid shrink-0 cursor-pointer place-items-center rounded-full border border-line text-ink-soft transition-colors hover:border-warn/50 hover:text-warn",
        slotClass(singleColumn),
      )}
    >
      <CloseIcon />
    </button>
  );
}

/**
 * 録音中。塗りの円に ● を置き、外周の弧で残り時間を示す（弧の割合は `voiceInputRemainingRatio` が返す）。
 * ■ (実行の停止) と形を変え、押すと何が止まるかを `aria-label` でも区別する。
 */
export function VoiceInputStopButton({
  singleColumn,
  remaining,
  onClick,
}: {
  singleColumn: boolean;
  /** 残り時間の割合 (1 → 0)。弧の角度だけに使う */
  remaining: number;
  onClick: () => void;
}) {
  const radius = 14.5;
  const circumference = 2 * Math.PI * radius;
  const visible = Math.min(Math.max(remaining, 0), 1);
  return (
    <button
      type="button"
      aria-label="録音を停止"
      title="録音を停止して文字起こしを確定します"
      onClick={onClick}
      className={cn(
        "relative grid shrink-0 cursor-pointer place-items-center rounded-full bg-accent text-on-accent transition-colors hover:brightness-110",
        slotClass(singleColumn),
      )}
    >
      <svg aria-hidden="true" viewBox="0 0 32 32" className="pointer-events-none absolute inset-0 size-full -rotate-90">
        <circle cx="16" cy="16" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" />
        <circle
          cx="16"
          cy="16"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - visible)}
        />
      </svg>
      <span className="size-2.5 rounded-full bg-current" aria-hidden="true" />
    </button>
  );
}

/** 確定待ち。送信も取消も受け付けないので、押せないスピナーにして主スロットを埋めたままにする */
export function VoiceInputFinalizingButton({ singleColumn }: { singleColumn: boolean }) {
  return (
    <button
      type="button"
      aria-label="文字起こしの確定待ち"
      title="確定したテキストを待っています"
      disabled
      className={cn(
        "grid shrink-0 cursor-not-allowed place-items-center rounded-full bg-accent text-on-accent opacity-45",
        slotClass(singleColumn),
      )}
    >
      <RunSpinnerIcon tone="on-accent" />
    </button>
  );
}
