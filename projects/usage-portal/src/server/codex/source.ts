/** サインインしていないときの source id。未接続の error だけをこのキーへ書く。 */
export const CODEX_SOURCE_ID = "codex";

/**
 * 履歴は ChatGPT のアカウントごとに分ける。サインアウトで snapshot を消しても sample は残し、
 * 同じアカウントで戻ったときだけ推移を引き継ぐ。
 */
export function codexSourceId(accountId: string | null): string {
  return accountId === null ? CODEX_SOURCE_ID : `${CODEX_SOURCE_ID}:${accountId}`;
}
