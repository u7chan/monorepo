import type { ClaudeRefreshOutcome, ClaudeResetCreditsOutcome } from "../api";

/** カードの表示に要る部分だけ。`/api/usage` の応答全体を持たなくても判定できる。 */
export type ClaudeSourceState = { capturedAt: number | null; error: { code: string } | null };

/** 端末でサインインするための固定のコマンド。カードと全体メニューの両方で同じ文言を出す。 */
export const CLAUDE_LOGIN_COMMAND = "docker exec -it <コンテナ名> claude auth login";

/** 設定ファイル由来の認証は CLI のログアウトで消えないことがあるため、条件つきの手順を添える。 */
export const CLAUDE_API_KEY_HELPER_NOTE =
  "設定ファイルで API キーを渡している場合（api_key_helper など）は、CLI のログアウトでは消えません。CLAUDE_CONFIG_DIR の設定から API キーの指定を外してください。";

/**
 * Claude のカードを出すか。取得前と未接続は出さない。取得エラーは、利用者が消せるようカードとして出す。
 * サーバーの loading 契約は変えないので、`/api/usage` の応答が来る前の骨格はここで隠れる。
 */
export function showsClaudeCard(source: ClaudeSourceState): boolean {
  if (source.error?.code === "not_connected") {
    return false;
  }

  return source.capturedAt !== null || source.error !== null;
}

/** カードが無いときの状態。カードと同じ error.code から、利用者が次にすることだけを書く。 */
export function claudeStatusLabel(source: ClaudeSourceState): string {
  switch (source.error?.code ?? null) {
    case null:
      return source.capturedAt === null ? "確認していません" : "取得済み";
    case "not_connected":
      return "未接続";
    case "reauth_required":
      return "サインインの期限が切れています";
    case "subscription_required":
      return "Pro / Max でのサインインが必要です";
    case "config":
      return "Claude の CLI を実行できません";
    case "schema":
      return "利用枠の出力を解釈できません";
    default:
      return "利用枠を取得できません";
  }
}

/** 取得の結果の文言。カードと全体メニューのモーダルで共通に使う。 */
export function claudeRefreshMessage(outcome: ClaudeRefreshOutcome | null): string {
  if (outcome === null) {
    return "通信に失敗しました。もう一度試してください。";
  }

  switch (outcome.state) {
    case "refreshed":
      return "利用枠を更新しました。";
    case "skipped":
      switch (outcome.reason) {
        case "fresh":
          return "15 分以内に取得した値を使っています。";
        case "cooldown":
          return "前回の更新から 60 秒経っていません。少し待ってから更新してください。";
        default:
          return "ログアウトの処理中です。終わってから確認してください。";
      }
    default:
      return "更新に失敗しました。状態を確認してください。";
  }
}

/** リセット枠の手動取得の結果。通常の更新とは別の入口なので、文言も分ける。 */
export function claudeResetCreditsMessage(outcome: ClaudeResetCreditsOutcome | null): string {
  if (outcome === null) {
    return "通信に失敗しました。もう一度試してください。";
  }

  if (outcome.state === "refreshed") {
    return "リセット枠を取得しました。";
  }

  if (outcome.state === "skipped") {
    return "ログアウトの処理中です。終わってから確認してください。";
  }

  switch (outcome.error) {
    case "reauth_required":
      return "サインインの期限が切れています。端末でサインインし直してください。";
    case "not_connected":
      return "Claude にサインインしていません。";
    case "schema":
      return "リセット枠の応答を解釈できませんでした。";
    default:
      return "リセット枠を取得できませんでした。時間をおいて試してください。";
  }
}
