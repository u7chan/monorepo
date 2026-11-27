/** 呼び出し元の lifecycle を見ない要求の既定。利用者の操作で始め、世代の競合だけを見ればよい取得に渡す */
export const alwaysCurrent = (): boolean => true;

/** 後から開始した要求と、呼び出し元の lifecycle を優先する応答適用ガード。 */
export function createRequestGate() {
  let latest = 0;
  return (isActive: () => boolean = alwaysCurrent) => {
    const request = ++latest;
    return () => isActive() && request === latest;
  };
}

export function createMountScope() {
  let active = true;
  let generation = 0;
  return {
    isActive: () => active,
    setup() {
      active = true;
      return () => {
        active = false;
        generation += 1;
      };
    },
    capture() {
      const startedActive = active;
      const startedGeneration = generation;
      return () => startedActive && active && startedGeneration === generation;
    },
  };
}

/**
 * 「いま飛んでいる要求」だけを追う。`begin()` の間だけ `pending()` が真で、後から始まった要求は
 * 前の要求を数えなくする (取得先が変わって前が返らなくても、次の要求を塞がない)。
 */
export function createRequestTracker() {
  let latest = 0;
  let pending = 0;
  return {
    begin(): () => void {
      const request = ++latest;
      pending = request;
      return () => {
        if (pending === request) pending = 0;
      };
    },
    pending(): boolean {
      return pending !== 0;
    },
  };
}

/**
 * 表示中の会話の履歴取得の世代。`begin()` が番号を返し、`holds(token)` が適用可否を返す。
 * `invalidate()` は進行中の要求を失効させる (失効前の古いページを適用すると表示が戻る)。
 */
export function createGenerationTracker() {
  let generation = 0;
  return {
    begin(): number {
      return ++generation;
    },
    holds(token: number): boolean {
      return token === generation;
    },
    invalidate(): void {
      generation += 1;
    },
  };
}

/**
 * 取得の「進行中」表示を追う。適用可否 (`createRequestGate`) とは別に持ち、破棄された要求の
 * 完了でも必ず解除する (可否で分岐するとフラグが立ちっぱなしになり再取得を塞ぐ)。
 */
export function createLoadingTracker(onChange: (loading: boolean) => void) {
  const tracker = createRequestTracker();
  let current = false;
  const publish = () => {
    const next = tracker.pending();
    if (next === current) return;
    current = next;
    onChange(next);
  };
  return {
    /** 要求の開始。返す関数は finally で必ず呼ぶ (canApply の判定で分岐しない) */
    begin(): () => void {
      const finish = tracker.begin();
      publish();
      return () => {
        finish();
        publish();
      };
    },
  };
}
