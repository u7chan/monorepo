/**
 * アプリ DB に暗号化して保存する APIキー / Webhook URL の復号状態と固定文言。
 * 方式・AAD・評価のタイミングは docs/secrets.md を正とする。
 */
/**
 * `keyStored` (暗号文がある) と対で使う復号の評価結果。`keyAvailable` は「いま値を使える」、
 * `keyEvaluated` は「復号を試したか」で、未評価を誤鍵・破損と断定しないために分ける。
 */
export interface AppSecretState {
  keyAvailable: boolean;
  keyEvaluated: boolean;
  /** 未評価 / 復号失敗の固定文言。キーが使えるときと未保存のときは null */
  keyErrorMessage: string | null;
}

/** master key が未設定 / 宣言が壊れている。復号を試せない既知の失敗 */
export const APP_SECRET_MASTER_KEY_MESSAGE =
  "master key（U7AGENT_SECRET_MASTER_KEY）が未設定または不正なため、保存済みのキーを復号できません。master key を設定するか、キーを再入力してください";
/** 誤鍵・未知の鍵版・改ざんで復号できない。平文へは落とさない */
export const APP_SECRET_DECRYPT_FAILED_MESSAGE =
  "保存済みのキーを復号できません。master key が変わっていないか確認し、キーを再入力してください";
/** runtime が無い / 起動時に DB を読めず、まだ復号を試していない */
export const APP_SECRET_UNEVALUATED_MESSAGE =
  "保存済みのキーを復号できるかまだ確認できていません。再起動するか、キーを保存し直してください";
/** 暗号化して保存できない (master key 未設定など)。503 の文言に使う */
export const APP_SECRET_NOT_STORED_MESSAGE = "master key が未設定または不正なため、APIキーを暗号化して保存できません";

/** 未評価。GET が暗号文だけを見つけた行と、起動時に復号できなかった行に使う */
export function appSecretUnevaluated(): AppSecretState {
  return { keyAvailable: false, keyEvaluated: false, keyErrorMessage: APP_SECRET_UNEVALUATED_MESSAGE };
}

/** 復号に成功して利用できる */
export function appSecretAvailable(): AppSecretState {
  return { keyAvailable: true, keyEvaluated: true, keyErrorMessage: null };
}

/** 暗号文が無い = キー未設定。エラーではないので文言を載せない */
export function appSecretNotStored(): AppSecretState {
  return { keyAvailable: false, keyEvaluated: true, keyErrorMessage: null };
}

/** 復号できない失敗。reason (誤鍵 / 未知の鍵版 / 改ざん) は区別せず、値を含まない固定文言へ寄せる */
export function appSecretFailed(): AppSecretState {
  return { keyAvailable: false, keyEvaluated: true, keyErrorMessage: APP_SECRET_DECRYPT_FAILED_MESSAGE };
}

/** master key が無い / 壊れていて復号を試せない */
export function appSecretMasterKeyMissing(): AppSecretState {
  return { keyAvailable: false, keyEvaluated: true, keyErrorMessage: APP_SECRET_MASTER_KEY_MESSAGE };
}
