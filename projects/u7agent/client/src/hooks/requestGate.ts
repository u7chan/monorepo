/** 後から開始した要求と、呼び出し元の lifecycle を優先する応答適用ガード。 */
export function createRequestGate() {
  let latest = 0;
  return (isActive: () => boolean = () => true) => {
    const request = ++latest;
    return () => isActive() && request === latest;
  };
}

/**
 * 「いま飛んでいる要求」だけを追う。`begin()` は開始を記録して完了時に呼ぶ関数を返し、その間だけ
 * `pending()` が真になる。**後から始まった要求は前の要求を数えなくする**ので、取得先が変わったときに
 * 前の要求が返らないまま残っても、次の要求や再取得を塞がない (「飛んでいる」は常に最新の要求 1 つ)。
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
 * 取得の「進行中」表示を追う。応答の適用可否 (`createRequestGate`) とは別に持ち、破棄された要求の
 * 完了でも必ず解除する (適用の可否で解除を分岐すると、フラグが立ちっぱなしになって再取得を塞ぐ)。
 * 後続の要求がある間だけ維持し、値が変わったときだけ `onChange` を呼ぶ。
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
