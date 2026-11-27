import type { VoiceInputAudioDeadline } from "./session";

/**
 * 期限後に音声フレームを落とす仕組みを画面側から作る。ブラウザでは期限の強制を worker に任せるが、
 * `RTCRtpScriptTransform` を持たないブラウザでは作らない (分岐を Node のテストから固定するため)。
 */
export function makeVoiceInputAudioDeadline(onError: () => void): VoiceInputAudioDeadline {
  if (!voiceInputFrameDeadlineSupported()) return { attach: () => {}, arm: () => {}, close: () => {} };
  // Vite が同一オリジンの別チャンクとして配信する。blob: を作らないので CSP の script-src を緩めない。
  // 起動や装着に失敗したら、期限を守れない録音を黙って続けず onError で中止させる
  const worker = new Worker(new URL("../../workers/voiceAudioDeadline.ts", import.meta.url), { type: "module" });
  worker.addEventListener("error", onError);
  worker.addEventListener("message", onError);
  return {
    attach(sender) {
      try {
        sender.transform = new RTCRtpScriptTransform(worker);
      } catch {
        onError();
      }
    },
    arm(deadline) {
      worker.postMessage(performance.timeOrigin + deadline);
    },
    close() {
      worker.terminate();
    },
  };
}

/** 期限後にフレームを落とせるブラウザか（画面の既知の制限と、worker を作るかの判定に使う） */
export function voiceInputFrameDeadlineSupported(): boolean {
  return typeof RTCRtpScriptTransform === "function";
}
