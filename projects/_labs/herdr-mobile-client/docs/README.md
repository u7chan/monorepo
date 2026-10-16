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
| [adr/0000-stack-and-dependency-policy.md](./adr/0000-stack-and-dependency-policy.md) | クライアントは Preact + 自前実装とし、第三者の UI 依存を足さない方針 |
| [adr/0001-dev-ports.md](./adr/0001-dev-ports.md) | サーバーの待ち受けと Vite の proxy 先で `PORT` を共有し、2 つ目の dev では両方を変える理由 |
| [adr/0002-api-client.md](./adr/0002-api-client.md) | クライアントが Hono RPC でサーバーのルート型を共有する理由 |
| [adr/0003-api-reference-for-ai.md](./adr/0003-api-reference-for-ai.md) | AI 向けの API 仕様をどう用意するか（提案） |
| [adr/0004-client-effect-discipline.md](./adr/0004-client-effect-discipline.md) | `useEffect` を DOM 操作など外部システムとの同期に限る方針 |
| [lan-access.md](./lan-access.md) | スマホから到達させるための Windows 側の設定手順（スクリプト）と、WSL2 再起動後の張り直し |
| [auth.md](./auth.md) | 共有トークンの与え方と判定、クライアントで `sessionStorage` に置く理由 |
| [pairing.md](./pairing.md) | QR ペアリングの流れ、一時コードの寿命と発行元の判定、保証の範囲と残存リスク |
