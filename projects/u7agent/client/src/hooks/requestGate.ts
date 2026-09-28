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
