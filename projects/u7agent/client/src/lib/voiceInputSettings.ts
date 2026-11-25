/**
 * 設定 → 音声入力（`/settings/voice-input`）の表示変換・文言・入力検証。DOM に依存しない関数だけを置く
 * （送信そのものは API 層が持ち、ここへは関数として渡す）。キーの有無と利用可否・固定モデルの正は
 * サーバー（`GET /api/settings/voice-input`）で、ここはその語彙だけを持つ。
 */
import type { VoiceInputSettingsResponse, VoiceInputTestFailure, VoiceInputTestResponse } from "../types";
import type { ConfirmRequest } from "./confirmDialog";
import type { ProviderBadge } from "./modelSettings";
import { messageFor } from "./errors";

/** キーの入力の境界。サーバー（server/src/schema/settings.ts）と同じ値で、外れた入力は送らない */
export const VOICE_INPUT_KEY_MIN_LENGTH = 8;
export const VOICE_INPUT_KEY_MAX_LENGTH = 2048;
/** 印字可能 ASCII だけを送る（制御文字・改行を Authorization ヘッダーへ渡さない） */
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/** 読み込み時の注記。再起動後も残ることを最初に伝える */
export const VOICE_INPUT_SETTINGS_NOTE = "音声入力の設定はサーバーに保存され、再起動後も残ります。";

/** キーの保存方式。master key が無いと復号できず、利用できないことも伝える */
export const VOICE_INPUT_KEY_ENCRYPTED_NOTE =
  "APIキーは暗号化してアプリのデータベース（SQLite）へ保存し、再起動後も使われます。保存したキーは再表示しません。master key（U7AGENT_SECRET_MASTER_KEY）が未設定の間は、保存済みのキーを使えません。";

export const VOICE_INPUT_NO_LOGIN_NOTE =
  "この GUI にはログインがありません。BFF をインターネットや LAN へ公開しないでください。";

/** モデルとデータの扱いの公式ページ。送信先と扱いを画面から辿れるようにする */
export const VOICE_INPUT_MODEL_DOC_URL = "https://platform.openai.com/docs/guides/realtime";
export const VOICE_INPUT_DATA_POLICY_URL = "https://platform.openai.com/docs/guides/your-data";

/** 実行中の操作。null なら操作なし */
export type VoiceInputSavingAction = "key" | "delete";

/**
 * キーの状態。保存の有無（`keyStored`）と利用可否（`keyAvailable`）を分け、
 * 「保存はあるが復号できない」を「未設定」と同じ見た目にしない。
 */
export function voiceInputKeyBadge(
  settings: Pick<VoiceInputSettingsResponse, "keyStored" | "keyAvailable">,
): ProviderBadge {
  if (!settings.keyStored) return { label: "未設定", tone: "muted" };
  return settings.keyAvailable ? { label: "利用可", tone: "ok" } : { label: "利用不可", tone: "warn" };
}

/** 保存済みのキーを使えない理由。未評価 / 復号失敗の文言はサーバーが返したものをそのまま出す */
export function voiceInputKeyErrorNotice(
  settings: Pick<VoiceInputSettingsResponse, "keyStored" | "keyAvailable" | "keyErrorMessage">,
): string | null {
  if (!settings.keyStored || settings.keyAvailable) return null;
  return settings.keyErrorMessage;
}

/**
 * ランタイム（マスカー）を持てない起動の案内。このときキーの登録・置換・疎通確認は 503 で、
 * 削除だけは受け付ける（暗号化にもマスカーにも依存しない）。
 */
export function voiceInputRuntimeNotice(settings: Pick<VoiceInputSettingsResponse, "runtimeAvailable">): string | null {
  return settings.runtimeAvailable
    ? null
    : "ランタイムが利用できないため、APIキーの登録・変更・疎通確認はできません。削除だけは行えます。サーバーの起動ログを確認してください。";
}

/** 入力の誤り。空 / 長さ / 文字種の順に見て、送れない理由を 1 つ返す */
export function voiceInputKeyError(value: string): string | undefined {
  if (value.length === 0) return "音声入力のAPIキーを入力してください。";
  if (value.length < VOICE_INPUT_KEY_MIN_LENGTH) {
    return `APIキーは ${VOICE_INPUT_KEY_MIN_LENGTH} 文字以上で入力してください。`;
  }
  if (value.length > VOICE_INPUT_KEY_MAX_LENGTH) {
    return `APIキーは ${VOICE_INPUT_KEY_MAX_LENGTH} 文字以内で入力してください。`;
  }
  if (!PRINTABLE_ASCII.test(value)) {
    return "APIキーは改行や制御文字を含まない、印字可能な半角の文字で入力してください。";
  }
  return undefined;
}

/** 保存を押せるか。未入力・不正・保存中・ランタイム無しでは送らない */
export function voiceInputKeyCanSave(
  settings: Pick<VoiceInputSettingsResponse, "runtimeAvailable">,
  value: string,
  busy: boolean,
): boolean {
  return settings.runtimeAvailable && !busy && voiceInputKeyError(value) === undefined;
}

/** 疎通確認を押せない理由。押す前に「何が足りないか」を読めるようにする */
export function voiceInputTestDisabledReason(
  settings: Pick<VoiceInputSettingsResponse, "runtimeAvailable" | "keyStored" | "keyAvailable" | "keyErrorMessage">,
): string | undefined {
  if (!settings.keyStored) return "APIキーを登録すると疎通確認できます。";
  if (!settings.keyAvailable) {
    return settings.keyErrorMessage ?? "保存済みのAPIキーを使える状態ではありません。";
  }
  if (!settings.runtimeAvailable) return "ランタイムが利用できないため、疎通確認はできません。";
  return undefined;
}

/**
 * 疎通確認が何をするか。課金されないことと、結果を保存しないことを押す前に伝える
 * （残高・失効で結果が古くなるため、ゲートにもしない）。
 */
export const VOICE_INPUT_TEST_NOTICE =
  "疎通確認は短命キーの発行だけを行い、音声は送らないため課金されません。結果は保存せず、録音の可否にも使いません。";

/**
 * 設定 → 音声入力の再生環境（プレイグラウンド）。話す前に、外へ出る・課金されうる・保存しないを 1 か所で伝える。
 * 残高不足の分類は `client/src/lib/voiceInput/playground.ts` の失敗ラベルが持つ。
 */
export function voiceInputPlaygroundNotice(model: string): string {
  return `話した音声は OpenAI（${model}）へ送られ、1 回の録音ごとに利用料がかかります。u7agent は音声も文字起こしも保存せず、履歴にも残しません。`;
}

/**
 * 期限後にフレームを落とせないブラウザの既知の制限。録音自体は成立するので中止せず、上限を守れない範囲を伝える
 * （期限の強制は `client/src/lib/voiceInput/deadline.ts`）。
 */
export const VOICE_INPUT_DEADLINE_LIMITATION =
  "このブラウザは上限を過ぎた音声の送信を止められません。画面が固まっている間に話した音声は、上限を超えて送られることがあります。";

/** プレイグラウンドの開始を押せない理由。押す前に「何が足りないか」を読めるようにする */
export function voiceInputPlaygroundDisabledReason(
  settings: Pick<VoiceInputSettingsResponse, "runtimeAvailable" | "keyStored" | "keyAvailable" | "keyErrorMessage">,
): string | undefined {
  if (!settings.keyStored) return "APIキーを登録すると録音を試せます。";
  if (!settings.keyAvailable) {
    return settings.keyErrorMessage ?? "保存済みのAPIキーを使える状態ではありません。";
  }
  if (!settings.runtimeAvailable) return "ランタイムが利用できないため、録音を試せません。";
  return undefined;
}

/** 音声の送信先と料金。録音を始める前に、外へ出ることを隠さない */
export function voiceInputBillingNotice(model: string): string {
  return `録音した音声は OpenAI（${model}）へ送られ、利用料がかかります。`;
}

/** u7agent が何を保存しないか。送信した本文は会話履歴に残ることまで書く（保存しない範囲を狭く読ませない） */
export const VOICE_INPUT_RETENTION_NOTICE =
  "u7agent は録音も未送信の文字起こしも永続化しません。確定したテキストは入力欄に入るだけで、自動送信はしません。送信した本文は通常の会話履歴に残ります。";

/**
 * secure context でないオリジンの案内。`getUserMedia` は HTTPS か localhost でしか動かないため、
 * 「このオリジンでは使えない」ことを設定画面で明示する（ボタンを出さない理由を探させない）。
 */
export function voiceInputSecureContextNotice(secureContext: boolean): string | null {
  return secureContext
    ? null
    : "このオリジンは HTTPS でも localhost でもないため、ブラウザのマイク（getUserMedia）を使えません。HTTPS か localhost で開いてください。";
}

/** 疎通結果の分類の日本語。`code` はサーバーの provider 失敗分類（provider-failure.ts）と同じ */
const VOICE_INPUT_FAILURE_LABELS: Record<VoiceInputTestFailure["code"], string> = {
  invalid_key: "キー無効",
  insufficient_credit: "残高不足",
  rate_limited: "混雑",
  timeout: "タイムアウト",
  aborted: "中断",
  unknown: "原因不明",
};

/**
 * 疎通結果の 1 行。成功はモデル名、失敗はサーバーの固定文言 + 分類を出す。
 * `unknown` は分類できない失敗（通信・想定外の応答）で、文言自体が理由なので分類を重ねない。
 */
export function voiceInputTestSummary(result: VoiceInputTestResponse): string {
  if (result.ok) return `接続できました（モデル ${result.model}）`;
  if (result.code === "unknown") return result.message;
  return `${result.message}（${VOICE_INPUT_FAILURE_LABELS[result.code]}）`;
}

/** 疎通確認を 1 回実行する。通信 / 503 の失敗も結果と同じ形へ畳み、描画側の分岐を 1 つに保つ */
export async function runVoiceInputTest(
  request: () => Promise<VoiceInputTestResponse>,
): Promise<VoiceInputTestResponse> {
  try {
    return await request();
  } catch (error) {
    return voiceInputTestFailure(messageFor(error));
  }
}

/** 通信 / 503 の失敗を結果と同じ形へ畳む。分類は付かないので `unknown` にする */
export function voiceInputTestFailure(message: string): VoiceInputTestFailure {
  return { ok: false, code: "unknown", message };
}

/** 表示するモデルの説明。固定モデルであることと、選べないことを 1 行で伝える */
export function voiceInputModelNote(model: string): string {
  return `録音の文字起こしには ${model} を固定で使います。モデルの選択はできません。`;
}

export function voiceInputSavedNote(): string {
  return "音声入力のAPIキーを保存しました。";
}

export function voiceInputDeletedNote(): string {
  return "音声入力のAPIキーを削除しました。マイクは表示されなくなります。";
}

/** キー削除の確認。再登録できる操作なので danger にはしない */
export function deleteVoiceInputKeyConfirmRequest(): ConfirmRequest {
  return {
    kind: "confirm",
    title: "音声入力のAPIキーを削除",
    subject: { label: "設定", value: "音声入力" },
    body: ["削除すると音声入力は使えなくなり、保存済みのキーは復元できません。再登録はできます。"],
    confirmLabel: "削除する",
  };
}
