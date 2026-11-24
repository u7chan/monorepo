function settledTail(operation: Promise<unknown>): Promise<void> {
  return operation.then(
    () => {},
    () => {},
  );
}

/** 待機に専用の期限は設けず、先行タスクの失敗はその呼び出し側にだけ返す。 */
export class SerialLock {
  #tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.#tail.then(task);
    this.#tail = settledTail(operation);
    return operation;
  }
}

/** キーごとの待機列。外部の待機用に返す末尾は reject しない。 */
export class KeyedSerialLock<K> {
  #tails = new Map<K, Promise<void>>();

  get(key: K): Promise<void> | undefined {
    return this.#tails.get(key);
  }

  has(key: K): boolean {
    return this.#tails.has(key);
  }

  values(): IterableIterator<Promise<void>> {
    return this.#tails.values();
  }

  async run<T>(key: K, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const operation = previous.then(task);
    const settled = settledTail(operation);
    this.#tails.set(key, settled);
    try {
      return await operation;
    } finally {
      // 呼び出し側が結果を受け取った時点で、終わった更新だけを進行中として残さない。
      if (this.#tails.get(key) === settled) this.#tails.delete(key);
    }
  }
}
