/**
 * 「ファイル参照からプレビューを開く」要求。未消費は 1 件だけ持ち、最新優先で置き換える。
 * 寿命は選択中セッションの滞在期間に限るため、破棄は選択が変わる経路 (useSessions) が呼ぶ。
 */

export type FileRefRequest = {
  /** 単調増加で再利用しない。適用済みの印と ack の照合に使う */
  seq: number;
  /** 要求を作ったときの選択中セッション。現在の選択と一致するときだけ子へ渡す */
  sessionId: string;
  /** cwd 相対のパス */
  path: string;
};

export function createFileRefRequests() {
  let seq = 0;
  let pending: FileRefRequest | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    /** useSyncExternalStore の購読 */
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** useSyncExternalStore の snapshot。未消費が無い間は同じ null を返す */
    snapshot(): FileRefRequest | null {
      return pending;
    },
    /** 未消費の要求を置き換える (最新優先)。セッションが未確定の要求は捨てる */
    request(sessionId: string, path: string): void {
      if (sessionId === "") return;
      pending = { seq: (seq += 1), sessionId, path };
      notify();
    },
    /** 適用済みの seq を返す。現在の要求と一致するときだけ消す (古い ack で新しい要求を消さない) */
    ack(appliedSeq: number): void {
      if (pending === null || pending.seq !== appliedSeq) return;
      pending = null;
      notify();
    },
    /** 選択の変更で破棄する (同じセッションに戻っても復活させない) */
    clear(): void {
      if (pending === null) return;
      pending = null;
      notify();
    },
  };
}

/** 選択中セッションの要求だけを子へ渡す (同一プロジェクトの別セッションは cwd が同じでも別扱い) */
export function fileRefRequestForSession(pending: FileRefRequest | null, sessionId: string): FileRefRequest | null {
  return pending !== null && pending.sessionId === sessionId ? pending : null;
}
