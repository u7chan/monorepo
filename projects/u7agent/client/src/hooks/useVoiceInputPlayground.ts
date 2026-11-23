import { useCallback, useEffect, useRef, useState } from "react";
import { browserVoiceInputPlatform, subscribeVoiceInputUnload } from "../lib/voiceInput/browser";
import {
  createVoiceInputPlayground,
  INITIAL_VOICE_INPUT_PLAYGROUND_STATE,
  type VoiceInputPlaygroundController,
  type VoiceInputPlaygroundState,
} from "../lib/voiceInput/playground";
import { startTranscription, type VoiceInputCapture } from "../lib/voiceInput/session";

/**
 * 設定 → 音声入力のプレイグラウンド。録音はこの画面を開いている間だけ動かし、離れる（アンマウント）と
 * マイク・peer・期限 worker を閉じる。state と終了の規則は `client/src/lib/voiceInput/playground.ts`。
 */
export function useVoiceInputPlayground(): {
  state: VoiceInputPlaygroundState;
  start: () => void;
  stop: () => void;
  cancel: () => void;
} {
  const [state, setState] = useState(INITIAL_VOICE_INPUT_PLAYGROUND_STATE);
  const controller = useRef<VoiceInputPlaygroundController | null>(null);

  useEffect(() => {
    const current = createVoiceInputPlayground({
      start: (callbacks): VoiceInputCapture => startTranscription(callbacks, { platform: browserVoiceInputPlatform }),
      now: () => performance.now(),
      subscribeUnload: subscribeVoiceInputUnload,
      onChange: setState,
    });
    controller.current = current;
    return () => {
      current.dispose();
      controller.current = null;
    };
  }, []);

  return {
    state,
    start: useCallback(() => controller.current?.start(), []),
    stop: useCallback(() => controller.current?.stop(), []),
    cancel: useCallback(() => controller.current?.cancel(), []),
  };
}
