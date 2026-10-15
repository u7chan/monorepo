# ADR 0001: サーバーの待ち受けと Vite の proxy 先で PORT を共有する

- Status: accepted
- Date: 2026-10-15

## 背景

`pnpm dev` は Hono（API サーバー）と Vite を同時に起動する。クライアントは `/api/...` を相対パスで呼び、
dev では Vite が `/api` を Hono へ proxy する。本番（`pnpm start`）は Hono が同一オリジンで配信するため、
クライアントの呼び出しパスは dev と本番で同じになる。

待ち受けポートと proxy 先をどう決めるかに選択の余地があり、指定漏れが起動時の分かりにくい失敗につながる。

## 決定

- サーバーの待ち受けポートは `PORT`（既定 3000）で決める。
- Vite の proxy 先も同じ `PORT` から導出し、proxy 専用の変数は作らない。
- Vite 自身のポートは `VITE_PORT`（既定 5173）で決める。
- 同じホストで 2 つ目の `pnpm dev` を起動するときは `PORT` と `VITE_PORT` を両方変える。

## 理由

- proxy 先を別の変数にすると、片方の指定漏れで `/api` だけ届かなくなる。同じ値を参照する限り、
  待ち受けと proxy 先がずれることはない。
- 2 つ目を起動するときに片方だけ変えると、変えなかった側のポートが 1 つ目の dev と衝突する。
  Vite は `strictPort` で止まるため、起動に失敗した理由は出力から分かる。

## 影響

- 2 つ目の dev は `PORT=3100 VITE_PORT=5273 pnpm dev` のように両方指定する。
- `PORT` を変えれば Vite の proxy 先も追従する。
