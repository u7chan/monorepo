/**
 * Composer のマイクを出してよいかの判定。理由の表示は設定 → 音声入力の注記だけが持ち、ここは
 * 「出す / 出さない」と、テストが区別できる分類だけを返す（入力欄の近くに理由を並べない）。
 */
import type { VoiceInputSettingsResponse } from "../../types";

/**
 * `available` 以外はマイクを出さない。`loading` は起動直後でまだ判定できていない状態で、
 * 取得失敗 (`unknown`) と分けるのは、再取得の機会があったかどうかをテストで区別するため。
 */
export type VoiceInputAvailability =
  | "available"
  | "loading"
  | "unknown"
  | "insecure-context"
  | "no-key"
  | "key-unavailable"
  | "runtime-unavailable";

export type VoiceInputAvailabilityInput = {
  /** `GET /api/settings/voice-input` の結果。未取得は null */
  settings: Pick<VoiceInputSettingsResponse, "keyStored" | "keyAvailable" | "runtimeAvailable"> | null;
  /** 取得に失敗したか（未取得のまま） */
  failed: boolean;
  /** `window.isSecureContext`（`getUserMedia` は HTTPS か localhost でしか動かない） */
  secureContext: boolean;
};

export function voiceInputAvailability({
  settings,
  failed,
  secureContext,
}: VoiceInputAvailabilityInput): VoiceInputAvailability {
  // オリジンが要件を満たさないときはキーの状態を見るまでもない（再取得しても変わらない）
  if (!secureContext) return "insecure-context";
  if (settings === null) return failed ? "unknown" : "loading";
  if (!settings.keyStored) return "no-key";
  if (!settings.keyAvailable) return "key-unavailable";
  if (!settings.runtimeAvailable) return "runtime-unavailable";
  return "available";
}

/** マイクを出すか。使えない理由は設定画面の注記にあるので、ここでは可否だけを返す */
export function voiceInputMicrophoneShown(availability: VoiceInputAvailability): boolean {
  return availability === "available";
}
