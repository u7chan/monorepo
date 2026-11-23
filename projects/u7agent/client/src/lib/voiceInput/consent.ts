/**
 * チャットから録音を始めるときの初回だけの確認。設定画面で説明済みでも省略しない
 * （設定を読んだことと、この会話で音声を送ることを承諾したことは別）。既読は localStorage の 1 キーに閉じる。
 */
import type { ConfirmRequest } from "../confirmDialog";
import { VOICE_INPUT_DATA_POLICY_URL } from "../voiceInputSettings";

export const VOICE_INPUT_CONSENT_STORAGE_KEY = "u7agent.voice-input.consent";

/** localStorage の代わりに使う最小の口。保存領域を持てない環境では null を渡し、毎回確認する */
export type VoiceInputConsentStorage = Pick<Storage, "getItem" | "setItem">;

/** 保存領域が無い・例外になる環境 (private browsing 等) でも録音は止めない。既読が残らないだけにする */
function safely<T>(
  action: (storage: VoiceInputConsentStorage) => T,
  storage: VoiceInputConsentStorage | null,
): T | null {
  if (storage === null) return null;
  try {
    return action(storage);
  } catch {
    return null;
  }
}

/** この端末で確認済みか */
export function voiceInputConsentGiven(storage: VoiceInputConsentStorage | null): boolean {
  return safely((store) => store.getItem(VOICE_INPUT_CONSENT_STORAGE_KEY) === "1", storage) === true;
}

/** 確認して録音を始めたことを覚える */
export function markVoiceInputConsent(storage: VoiceInputConsentStorage | null): void {
  safely((store) => store.setItem(VOICE_INPUT_CONSENT_STORAGE_KEY, "1"), storage);
}

/** localStorage の accessor 自体が例外になる環境 (private browsing 等) がある。無い環境では null */
export function voiceInputConsentStorage(): VoiceInputConsentStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * 初回の確認。音声が外へ出て課金されること・u7agent が保存しないことを、開始前に 1 画面で伝える。
 */
export function voiceInputConsentRequest(model: string): ConfirmRequest {
  return {
    kind: "confirm",
    title: "音声入力を始める",
    body: [
      `話した音声は OpenAI（${model}）へ送られ、録音のたびに利用料がかかります。`,
      "u7agent は音声も途中の文字起こしも保存しません。確定したテキストは入力欄に入るだけで、自動送信はしません。",
      "この確認は最初の 1 回だけ表示します。",
    ],
    links: [{ label: "OpenAI のデータの取り扱い", href: VOICE_INPUT_DATA_POLICY_URL }],
    confirmLabel: "録音を始める",
  };
}

/**
 * 録音を始めてよいかを確かめる。未確認なら確認を出し、取り消されたら false を返す（呼び出し側は録音を始めない）。
 * 確認済みの記録は、利用者が承諾したときだけ残す。
 */
export async function requestVoiceInputConsent({
  storage,
  confirm,
  model,
}: {
  storage: VoiceInputConsentStorage | null;
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  model: string;
}): Promise<boolean> {
  if (voiceInputConsentGiven(storage)) return true;
  if (!(await confirm(voiceInputConsentRequest(model)))) return false;
  markVoiceInputConsent(storage);
  return true;
}
