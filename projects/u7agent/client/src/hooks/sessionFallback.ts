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
  const next = sessions.find((item) => !failed.has(item.sessionId));
  return next ? { kind: "select", sessionId: next.sessionId } : { kind: "newChat" };
}
