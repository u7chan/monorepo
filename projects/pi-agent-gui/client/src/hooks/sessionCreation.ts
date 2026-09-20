/**
 * セッション作成の in-flight 共有。同時アップロード / 送信で同じ作成を待ち、会話を切り替えたら
 * 進行中の作成を捨てる (捨てないと、新しい会話の送信が前のセッションを掴む)。
 */
export function createSessionCreation<T>() {
  let inflight: Promise<T> | null = null;
  return {
    /** 進行中があれば共有し、無ければ create を開始する。 */
    start(create: () => Promise<T>): Promise<T> {
      if (inflight) return inflight;
      const promise = create();
      inflight = promise;
      void promise
        .catch(() => {})
        .finally(() => {
          // 失敗しても待ち手は各呼び出し元へ伝える。clear 後に別の作成が始まっていたら触らない
          if (inflight === promise) inflight = null;
        });
      return promise;
    },
    /** 進行中の作成を捨てる。次の start は新しく作る (古い作成の完了で上書きしない)。 */
    clear(): void {
      inflight = null;
    },
  };
}
