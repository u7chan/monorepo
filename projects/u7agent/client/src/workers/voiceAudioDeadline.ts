import { audioBeforeDeadline, audioDeadlineClock } from "../lib/voiceInput/audioDeadline";

/**
 * 録音の期限を過ぎた音声フレームを落とす worker。main thread のタイマーだけでは止まっている間も音声が
 * 送られ続けるため、送信のパイプライン側で切る (静的 `new Worker(new URL(...))` で `blob:` を作らない)。
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
