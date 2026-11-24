/**
 * 認証変更・DB 書込・state 公開を直列化する 1 本のロック。コンテンツ生成の設定も同じ型のロックで直列化する。
 * 前のタスクの失敗でチェーンを止めず、呼び出し側へは自分のタスクの結果だけを返す。
 */
export class MutationLock {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(task, task);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
