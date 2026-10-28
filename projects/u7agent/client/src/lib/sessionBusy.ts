/**
 * 会話が実行中かどうかの判定を 1 か所に置く。BFF の `SessionStore.isBusy`（`server/src/sessions.ts`）と
 * 同じ集合（実行 / キュー待ち / 圧縮中）で、終端（`completed` / `stopped` / `error`）と `idle` は false。
 * 同じ 3 値判定を画面ごとに書き分けると、集合が変わったときに片側だけ追随しない経路が残る。
 */
export function sessionBusy(runStatus: string): boolean {
  return runStatus === "running" || runStatus === "queued" || runStatus === "compacting";
}
