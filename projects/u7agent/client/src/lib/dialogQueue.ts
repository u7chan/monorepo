/**
 * 確認・入力ダイアログの待ち行列。モーダルは常に 1 つだけ出し、開いている間の要求は順番待ちにする。
 * 応答は先頭の要求にだけ対応付け、古い応答は無視する。先の要求の Promise を未解決のまま捨てると、
 * 呼び出し側の `finally` が走らず二重送信ガード（実行中のパスを持つ ref）が残るため、必ず解決させる。
 */

export type DialogQueueEntry = { readonly id: number };

export type DialogQueue<T extends DialogQueueEntry> = {
  /** 末尾へ積む */
  push(entry: T): void;
  /** いま画面に出す先頭。無ければ undefined */
  head(): T | undefined;
  /** 先頭の要求への応答だけを受け付ける。取り出せたら true (次の要求が先頭になる) */
  settle(id: number): boolean;
};

export function createDialogQueue<T extends DialogQueueEntry>(): DialogQueue<T> {
  const entries: T[] = [];
  return {
    push(entry) {
      entries.push(entry);
    },
    head() {
      return entries[0];
    },
    settle(id) {
      if (entries[0]?.id !== id) return false;
      entries.shift();
      return true;
    },
  };
}
