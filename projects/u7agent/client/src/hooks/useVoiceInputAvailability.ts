import { useCallback, useEffect, useState } from "react";
import { getVoiceInputSettings } from "../api/settings";
import {
  voiceInputAvailability,
  voiceInputMicrophoneShown,
  type VoiceInputAvailability,
} from "../lib/voiceInput/availability";
import type { VoiceInputSettingsResponse } from "../types";

type Loaded = Pick<VoiceInputSettingsResponse, "keyStored" | "keyAvailable" | "runtimeAvailable" | "model">;

type Fetched = { settings: Loaded | null; failed: boolean } | null;

/**
 * 入力欄のマイクを出せるかの材料。取得は App の起動時に 1 回だけ行い、設定 → 音声入力でキーを
 * 保存 / 削除したときに `reload()` で取り直す（キーの状態の正はサーバー）。
 * 失敗しても会話は止めず、マイクを出さないだけにする。
 */
export function useVoiceInputAvailability(): {
  availability: VoiceInputAvailability;
  shown: boolean;
  /** 確認ダイアログに出す固定モデル。未取得は空文字 */
  model: string;
  reload: () => void;
} {
  /** 未取得は null。取得中の再要求で状態を消さないよう、失敗だけを別に持たない */
  const [fetched, setFetched] = useState<Fetched>(null);
  /** 取り直しの番号。同じ番号の取得が終わる前に次が始まったら、古い応答は捨てる */
  const [request, setRequest] = useState(0);

  const reload = useCallback(() => setRequest((value) => value + 1), []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const next = await getVoiceInputSettings();
        if (!live) return;
        setFetched({
          settings: {
            keyStored: next.keyStored,
            keyAvailable: next.keyAvailable,
            runtimeAvailable: next.runtimeAvailable,
            model: next.model,
          },
          failed: false,
        });
      } catch {
        if (!live) return;
        setFetched({ settings: null, failed: true });
      }
    })();
    return () => {
      live = false;
    };
  }, [request]);

  const availability = voiceInputAvailability({
    settings: fetched?.settings ?? null,
    failed: fetched?.failed === true,
    secureContext: window.isSecureContext,
  });
  return {
    availability,
    shown: voiceInputMicrophoneShown(availability),
    model: fetched?.settings?.model ?? "",
    reload,
  };
}
