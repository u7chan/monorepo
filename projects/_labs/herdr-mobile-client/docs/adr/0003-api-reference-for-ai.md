# ADR 0003: AI 向けの API 仕様は OpenAPI 3.1 をコードから生成して配信する

- Status: proposed（未決定）
- Date: 2026-10-15

## 背景

API の説明を README のような人間向けの文書へ書かない（人間は読まず、実装と乖離して壊れる）。
一方で、API の契約を読む相手は将来の AI（コーディングエージェントや自動クライアント）になる。
リポジトリ内のクライアント自身は Hono RPC で型を共有するため（[ADR 0002](./0002-api-client.md)）、呼び出しに別途の仕様書は要らない。

## 選択肢

1. Hono RPC の型だけを正本にする
   - 同じリポジトリの TypeScript を読む AI には十分。ただし HTTP の契約（ステータスコード、エラー、SSE）は型に出にくい。
2. OpenAPI 3.1 をコードから生成して配信する
   - `hono-openapi` を使い、ルートに Standard Schema（zod / valibot / arktype など）のスキーマを付けて
     `/api/openapi.json` を配信する。
   - ランタイム検証と仕様が同じ定義から得られる。AI は URL を 1 度読めば契約全体を取得できる。
   - `@hono/zod-openapi` でも同じことはできるが Zod 固定で、`hc` との型推論に既知の制約がある。
3. 手書きの Markdown 仕様
   - 実装と乖離しやすく、乖離をテストで検出できない。採用しない。

## 提案

2 を採用する。配信するのはまず `/api/openapi.json` だけでよい（人間が見ないなら UI は不要）。
UI を足す場合も Swagger UI より Scalar を推す（軽量でモバイルでも読める）。
Zod ではなく valibot など別のスキーマライブラリを選ぶ余地を残すため、`hono-openapi` の Standard Schema 対応を使う。

実装は Herdr 連携の API を足すステップ（#1993 以降）で、最初のルートにスキーマを付けるところから始める。
SSE を扱う段になったら、OpenAPI で表せない部分をどう記録するか（AsyncAPI など）を別途決める。
