# docs/

`herdr-mobile-client` のドキュメントのインデックス。

## ドキュメントポリシー

コードを読めば分かることは書かない。次に当てはまるものだけを置く。

- 当時の意思決定（ADR）
- コードに複雑なコメントとして残したくない情報
- 手順対応が必要なもの（運用手順など）

リポジトリ直下の `docs/` はモノレポ全体の文書であり、ここにはこのプロジェクト固有の内容だけを書く。

## 一覧

| 文書 | 内容 |
| --- | --- |
| [adr/0001-dev-ports.md](./adr/0001-dev-ports.md) | サーバーの待ち受けと Vite の proxy 先で `PORT` を共有し、2 つ目の dev では両方を変える理由 |
| [adr/0002-api-client.md](./adr/0002-api-client.md) | クライアントが Hono RPC でサーバーのルート型を共有する理由 |
| [adr/0003-api-reference-for-ai.md](./adr/0003-api-reference-for-ai.md) | AI 向けの API 仕様をどう用意するか（提案） |
