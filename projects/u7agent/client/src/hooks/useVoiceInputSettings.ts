import { useCallback, useState } from "react";
import { deleteVoiceInputKey, getVoiceInputSettings, postVoiceInputTest, putVoiceInputKey } from "../api/settings";
import {
  runVoiceInputTest,
  voiceInputDeletedNote,
  voiceInputKeyError,
  voiceInputSavedNote,
  VOICE_INPUT_SETTINGS_NOTE,
  type VoiceInputSavingAction,
} from "../lib/voiceInputSettings";
import type { VoiceInputSettingsResponse, VoiceInputTestResponse } from "../types";
import { useSettingsResource } from "./useSettingsResource";

/**
 * 設定 → 音声入力の state と操作。GET はこの画面を開いたときだけ取り、変更系の応答は GET と同じ形なので
 * 注記を付けてそのまま次の状態にできる。保存は「その場で効く」前提なので、失敗したら状態を変えず理由だけを出す。
 */
export function useVoiceInputSettings() {
  const [testing, setTesting] = useState(false);
  const [testOutcome, setTestOutcome] = useState<VoiceInputTestResponse | null>(null);
  // キーが変わると前のキーで取った疎通結果は証拠にならない（未設定へ戻したら結果ごと消す）
  const clearTestOutcome = useCallback(() => setTestOutcome(null), []);
  const { settings, note, saving, reloading, reload, runMutation, setNote } = useSettingsResource<
    VoiceInputSettingsResponse,
    VoiceInputSavingAction
  >({
    defaultNote: VOICE_INPUT_SETTINGS_NOTE,
    loadErrorLabel: "音声入力の設定を読み込めませんでした。",
    load: getVoiceInputSettings,
    onApply: clearTestOutcome,
  });

  const saveKey = useCallback(
    (apiKey: string): Promise<boolean> => {
      const invalid = voiceInputKeyError(apiKey);
      if (invalid) {
        setNote({ text: invalid, error: true });
        return Promise.resolve(false);
      }
      return runMutation("key", voiceInputSavedNote(), () => putVoiceInputKey(apiKey));
    },
    [runMutation, setNote],
  );

  const removeKey = useCallback(
    (): Promise<boolean> => runMutation("delete", voiceInputDeletedNote(), deleteVoiceInputKey),
    [runMutation],
  );

  /** 疎通確認。記録はしないので、結果は次の取得（再読み込み / 保存）まで表示だけに残す */
  const test = useCallback(async (): Promise<void> => {
    setTesting(true);
    try {
      setTestOutcome(await runVoiceInputTest(postVoiceInputTest));
    } finally {
      setTesting(false);
    }
  }, []);

  return { settings, note, saving, reloading, reload, saveKey, removeKey, testing, testOutcome, test };
}

export type VoiceInputSettings = ReturnType<typeof useVoiceInputSettings>;
