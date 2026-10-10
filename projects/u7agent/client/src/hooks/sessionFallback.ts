/**
 * 開けなかったセッションの代わりに試す候補の選択。
 *
 * 「自分以外の先頭」を選ぶだけだと、破損などで複数のセッションが開けないとき、候補が互いを
 * 指して同じ 2 つを往復し続ける (1 回の起動で数百リクエスト)。呼び出し側はこの連鎖で試した id を
 * 渡し、一覧を 1 周したら未作成チャットへ落とす。
 */
export type SessionCandidate = { sessionId: string };

export type SessionFallbackAction = { kind: "select"; sessionId: string } | { kind: "newChat" };

/** `failed` は今までに試して開けなかった id (直前に失敗した id を含む)。 */
export function nextAfterFailure(
  sessions: readonly SessionCandidate[],
  failed: ReadonlySet<string>,
): SessionFallbackAction {
  return selectOrNewChat(sessions.find((item) => !failed.has(item.sessionId)));
}

/**
 * 一覧から消えた会話 (削除 / 引っ越し) の代わりに選ぶ移り先。先頭の会話、無ければ未作成チャットにする
 * (消えた会話を掴んだままにしない)。
 */
export function nextAfterRemoval(sessions: readonly SessionCandidate[]): SessionFallbackAction {
  return selectOrNewChat(sessions[0]);
}

function selectOrNewChat(next: SessionCandidate | undefined): SessionFallbackAction {
  return next ? { kind: "select", sessionId: next.sessionId } : { kind: "newChat" };
}
