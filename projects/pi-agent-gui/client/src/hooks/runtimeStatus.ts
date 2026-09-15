import type { Health } from "../types";

/** モデルは含めない (会話モデルの表示は別コンポーネントが持つ) */
export type RuntimeStatus = {
  text: string;
  error: boolean;
  detail?: string;
  authRequired?: boolean;
  sandboxRequired?: boolean;
};

export const AUTH_REQUIRED_TEXT = "APIキー未設定";
export const SANDBOX_REQUIRED_TEXT = "実行環境（サンドボックス）が未設定";

/** バッククォートの部分は RuntimeAlert が <code> で描画する */
export const AUTH_REQUIRED_GUIDE =
  "`cp .env.example .env` で設定ファイルを作成し、APIキーを入力してからサーバーを再起動してください。";

const SANDBOX_REQUIRED_REASON = "BFF にサンドボックスの接続情報が無いため、セッション作成（送信）が 503 になります。";

/**
 * 実行環境の復旧手順。`.env` は BFF だけが読むため、サンドボックスへ渡す値まで示す
 * (コマンドと環境変数は README「ローカルで起動する（Docker なし）」と揃える)。
 */
export const SANDBOX_REQUIRED_GUIDE =
  "ローカルでは `pnpm dev` でサンドボックスごと起動し直してください（共有トークンと作業領域は dev スクリプトが渡します）。個別に起動している場合は、サンドボックスへ `SANDBOX_HOST=127.0.0.1` / `PI_SANDBOX_TOKEN`（16文字以上）/ `PI_SANDBOX_CWD` を CLI で渡し、BFF へ `PI_SANDBOX_URL` と同名のトークンを設定してください。";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 認証もサンドボックス未設定も 503 になり HTTP ステータスでは区別できないため、本文で判定する。
const AUTH_ERROR_PATTERN = /APIキー|No API key found|Provider is not configured|No model selected/i;
const SANDBOX_ERROR_PATTERN = /サンドボックス|sandbox/i;

export function runtimeStatusForError(error: unknown): RuntimeStatus {
  const detail = errorText(error);
  if (SANDBOX_ERROR_PATTERN.test(detail)) {
    return { text: SANDBOX_REQUIRED_TEXT, error: true, detail, sandboxRequired: true };
  }
  const authRequired = AUTH_ERROR_PATTERN.test(detail);
  return { text: authRequired ? AUTH_REQUIRED_TEXT : "エラー", error: true, detail, authRequired };
}

/**
 * health から接続状態を作る。ready: false の原因 (認証・whitelist・初期化失敗) を優先し、
 * ready: true のときだけ実行環境の未設定を既定モデルのエラーより先に知らせる。
 */
export function runtimeStatusForHealth(health: Health): RuntimeStatus {
  if (!health.ready) {
    const authRequired = health.errorCode === "authentication_required";
    return {
      text: authRequired ? AUTH_REQUIRED_TEXT : "ランタイム未接続",
      error: true,
      detail: health.error || health.availabilityError || "APIキーまたは認証設定を確認してください",
      authRequired,
    };
  }
  // health.model はアプリ既定であり選択中セッションの実効モデルとは限らないため、ここでは接続状態だけを作る。
  if (health.sandboxConfigured === false) {
    return {
      text: SANDBOX_REQUIRED_TEXT,
      error: true,
      detail: SANDBOX_REQUIRED_REASON,
      sandboxRequired: true,
    };
  }
  if (health.defaultModelError) {
    return { text: "モデル未選択", error: true, detail: health.defaultModelError };
  }
  return { text: "接続中", error: false };
}
