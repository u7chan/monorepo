import type { CodexLoginState } from "../api";

export type CodexPanelVisibility = {
  /** /api/codex/auth を取得済みか。取得前は未接続と決めつけず、操作を出さない。 */
  known: boolean;
  needsSignIn: boolean;
  signedIn: boolean;
  loginStatus: CodexLoginState["status"] | null;
};

/**
 * 開始ボタンを出すか。終端の `succeeded` が残っていても、サインアウト後や再認証では
 * 入り直せる必要がある（資格情報が無い・失効しているのに操作が消えると復帰できない）。
 */
export function showsStartButton(visibility: CodexPanelVisibility): boolean {
  if (!visibility.known || visibility.loginStatus === "running") {
    return false;
  }

  return (
    visibility.needsSignIn ||
    !visibility.signedIn ||
    visibility.loginStatus === "failed" ||
    visibility.loginStatus === "cancelled"
  );
}

/** サインアウトは、有効な資格情報があってサインインが進行していないときだけ出す。 */
export function showsSignOutButton(visibility: CodexPanelVisibility): boolean {
  return visibility.known && visibility.signedIn && !visibility.needsSignIn && visibility.loginStatus !== "running";
}
