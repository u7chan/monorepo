import type { SessionPinnedResponse } from "../types";

export interface PinnedToggleDeps {
  /** 表示一覧の値を更新する。spaceId は遅れて届いた別スペースの応答を捨てるために渡す */
  apply: (sessionId: string, pinned: boolean, spaceId: string) => void;
  request: (sessionId: string, pinned: boolean) => Promise<SessionPinnedResponse>;
  isCurrentSpace: (spaceId: string) => boolean;
  onError: (error: unknown, spaceId: string) => void;
}

export interface PinnedToggleRunner {
  toggle: (sessionId: string, current: boolean, spaceId: string) => void;
}

/** 同一会話の更新を直列化し、保存に失敗した最新操作は確定済み値へ戻す。 */
export function createPinnedToggleRunner(deps: PinnedToggleDeps): PinnedToggleRunner {
  const chains = new Map<string, Promise<void>>();
  const latest = new Map<string, number>();
  const confirmed = new Map<string, boolean>();
  let seq = 0;
  const keyOf = (spaceId: string, sessionId: string) => `${spaceId}\0${sessionId}`;

  const run = async (sessionId: string, next: boolean, spaceId: string, key: string, token: number): Promise<void> => {
    if (!deps.isCurrentSpace(spaceId)) return;
    try {
      const result = await deps.request(sessionId, next);
      if (result.sessionId !== sessionId) throw new Error("セッションの応答が一致しません");
      confirmed.set(key, result.pinned);
      if (latest.get(key) === token && deps.isCurrentSpace(spaceId)) {
        deps.apply(sessionId, result.pinned, spaceId);
      }
    } catch (error) {
      if (latest.get(key) !== token || !deps.isCurrentSpace(spaceId)) return;
      deps.apply(sessionId, confirmed.get(key) ?? !next, spaceId);
      deps.onError(error, spaceId);
    }
  };

  return {
    toggle(sessionId, current, spaceId): void {
      if (!sessionId || !deps.isCurrentSpace(spaceId)) return;
      const key = keyOf(spaceId, sessionId);
      if (!chains.has(key) || !confirmed.has(key)) confirmed.set(key, current);
      const token = (seq += 1);
      latest.set(key, token);
      const next = !current;
      deps.apply(sessionId, next, spaceId);
      const previous = chains.get(key) ?? Promise.resolve();
      const chained = previous.then(() => run(sessionId, next, spaceId, key, token));
      chains.set(key, chained);
      void chained.finally(() => {
        if (chains.get(key) === chained) chains.delete(key);
      });
    },
  };
}
