import { audioBeforeDeadline, audioDeadlineClock } from "../lib/voiceInput/audioDeadline";

/**
 * 録音の期限を過ぎた音声フレームを落とす worker。画面側のタイマーだけでは、main thread が止まっている間も
 * 音声が送られ続けるため、送信のパイプライン側で切る。
 *
 * Vite が同一オリジンの別チャンクとして配信し、ブラウザ用の factory が静的な `new Worker(new URL(...))` で読む
 * （`blob:` を作らず CSP の `script-src` を緩めない）。Worker 専用の tsconfig で型を検査する。
 */

/** 期限は 1 回だけ受ける。以後のメッセージで延ばせないようにする */
let deadline = Number.POSITIVE_INFINITY;

self.addEventListener("message", (event: MessageEvent) => {
  if (deadline === Number.POSITIVE_INFINITY && Number.isFinite(event.data)) deadline = event.data as number;
});

self.addEventListener("rtctransform", (event) => {
  const { transformer } = event as MessageEvent & { transformer: RTCRtpScriptTransformer };
  void transformer.readable
    .pipeThrough(audioBeforeDeadline(() => deadline, audioDeadlineClock()))
    .pipeTo(transformer.writable)
    .catch(() => self.postMessage("audio-filter-error"));
});
