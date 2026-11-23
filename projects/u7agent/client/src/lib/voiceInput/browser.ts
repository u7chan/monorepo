import { ApiError, postVoiceInputSession } from "../../api";
import { makeVoiceInputAudioDeadline } from "./deadline";
import type { VoiceInputPlatform, VoiceInputSessionAnswer } from "./session";

/**
 * 録音 1 回分のブラウザ側の実体。時計は `performance.now`、期限の強制は同一オリジンの worker
 * （`./deadline.ts`）、セッションの要求は BFF（`/api/voice-input/session`）へ出す。
 */
export const browserVoiceInputPlatform: VoiceInputPlatform = {
  getMicrophone: () => navigator.mediaDevices.getUserMedia({ audio: true }),
  makePeer: () => new RTCPeerConnection(),
  makeAudioDeadline: makeVoiceInputAudioDeadline,
  request: (offer, signal) => requestAnswer(offer, signal),
  now: () => performance.now(),
};

/**
 * タブを閉じる / 戻るで録音を残さない。`pagehide` は bfcache へ入る場合にも届く
 * （`beforeunload` はモバイルで発火しないことがある）。
 */
export function subscribeVoiceInputUnload(listener: () => void): () => void {
  window.addEventListener("pagehide", listener);
  return () => window.removeEventListener("pagehide", listener);
}

/** BFF の失敗は HTTP の分類つきで返る。切断（abort）は呼び出し側が世代で捨てる */
async function requestAnswer(offer: string, signal: AbortSignal): Promise<VoiceInputSessionAnswer> {
  try {
    return { ok: true, sdp: await postVoiceInputSession(offer, signal) };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, message: "音声の接続を開始できませんでした。通信状態を確認してください。" };
  }
}
