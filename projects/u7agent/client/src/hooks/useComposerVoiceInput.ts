import { useCallback, useEffect, useRef, useState } from "react";
import { browserVoiceInputPlatform, subscribeVoiceInputUnload } from "../lib/voiceInput/browser";
import {
  createVoiceInputComposer,
  INITIAL_VOICE_INPUT_COMPOSER_STATE,
  type VoiceInputComposerCallbacks,
  type VoiceInputComposerController,
  type VoiceInputComposerState,
} from "../lib/voiceInput/composer";
import { startTranscription, type VoiceInputCapture } from "../lib/voiceInput/session";

/**
 * 入力欄から始める録音 1 回分。DOM を持たない制御は `client/src/lib/voiceInput/composer.ts` に置き、
 * ここはブラウザの実体（マイク・peer・期限 worker）と `pagehide` の購読を結ぶだけにする。
 * 終了の規則（画面移動・会話の切替・アンマウント）は呼び出し側が `cancel()` を呼んで揃える。
 */
export function useComposerVoiceInput(): {
  state: VoiceInputComposerState;
  start: (callbacks: VoiceInputComposerCallbacks) => void;
  stop: () => void;
  cancel: () => void;
} {
  const [state, setState] = useState(INITIAL_VOICE_INPUT_COMPOSER_STATE);
  const controller = useRef<VoiceInputComposerController | null>(null);

  useEffect(() => {
    const current = createVoiceInputComposer({
      start: (callbacks): VoiceInputCapture => startTranscription(callbacks, { platform: browserVoiceInputPlatform }),
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
    start: useCallback((callbacks: VoiceInputComposerCallbacks) => controller.current?.start(callbacks), []),
    stop: useCallback(() => controller.current?.stop(), []),
    cancel: useCallback(() => controller.current?.cancel(), []),
  };
}
