import type { GeminiLogoutOutcome, GeminiRefreshOutcome } from "../api";
import { claudeRefreshMessage } from "./claude";

/** カードの表示に要る部分だけ。`/api/usage` の応答全体を持たなくても判定できる。 */
export type GeminiSourceState = { capturedAt: number | null; error: { code: string } | null };

/**
 * 端末でサインインするための固定のコマンド。カードと全体メニューの両方で同じ文言を出す。
 * `agy` は設定と token を `$HOME` の下に置くため、アプリが使う `HOME` を渡して起動する。
 */
export const GEMINI_LOGIN_COMMAND = "docker exec -it -e HOME=/app/credentials/antigravity <コンテナ名> agy";

/** `CREDENTIAL_DIR` を既定から変えたときだけ要る補足。 */
export const GEMINI_CREDENTIAL_DIR_NOTE =
  "CREDENTIAL_DIR を既定の /app/credentials から変えている場合は、HOME も <CREDENTIAL_DIR>/antigravity に合わせてください。";

/** 取れる枠の範囲。プラン名は取れないので断定しない。 */
export const GEMINI_SCOPE_NOTE = "Antigravity の Gemini Models の枠です。Gemini アプリ・Gemini CLI の上限とは別です。";

/**
 * Gemini のカードを出すか。取得前と未接続は出さない。取得エラーは、利用者が消せるようカードとして出す。
 * サーバーの loading 契約は変えないので、`/api/usage` の応答が来る前の骨格はここで隠れる。
 */
export function showsGeminiCard(source: GeminiSourceState): boolean {
  if (source.error?.code === "not_connected") {
    return false;
  }

  return source.capturedAt !== null || source.error !== null;
}

/** カードが無いときの状態。カードと同じ error.code から、利用者が次にすることだけを書く。 */
export function geminiStatusLabel(source: GeminiSourceState): string {
  switch (source.error?.code ?? null) {
    case null:
      return source.capturedAt === null ? "確認していません" : "取得済み";
    case "not_connected":
      return "未接続";
    case "config":
      return "Gemini の CLI を実行できません";
    case "schema":
      return "利用枠の出力を解釈できません";
    default:
      return "利用枠を取得できません";
  }
}

/** 取得の結果の文言。契機の制限は Claude と同じなので、文言も同じにする。 */
export function geminiRefreshMessage(outcome: GeminiRefreshOutcome | null): string {
  return claudeRefreshMessage(outcome);
}

/** ログアウトが完了しなかったときの文言。完了のときはカードが消えるので出さない。 */
export function geminiLogoutMessage(outcome: Exclude<GeminiLogoutOutcome, "done"> | null): string {
  if (outcome === "incomplete") {
    return "資格情報を削除しましたが、CLI がまだ接続済みと答えています。カードは残しています。もう一度ログアウトしてください。";
  }

  return "ログアウトできませんでした。もう一度試してください。";
}
