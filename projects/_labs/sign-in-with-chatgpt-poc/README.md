# sign-in-with-chatgpt-poc

Epic [#1935](https://github.com/u7chan/monorepo/issues/1935) の PoC を 2 段階で検証するための置き場です。
どちらのサンプルも単独で起動・動作し、互いの生成物やトークンに依存しません。

```text
projects/_labs/sign-in-with-chatgpt-poc/
├── openai-sdk/   # Phase 1: OpenAI公式SDK + SIWC（#1936）
├── pi-sdk/       # Phase 2: Pi SDK + SIWC（#1937、未着手）
└── README.md
```

## Phase 1: OpenAI公式SDK + SIWC

`openai` SDK の Bearer 認証に SIWC の OAuth アクセストークンを使い、公開 Responses API をストリーミングで呼びます。
実行手順・前提条件・実測結果・制約は [openai-sdk/README.md](./openai-sdk/README.md) にあります。

## Phase 2: Pi SDK + SIWC

未着手です。Phase 1 のサンプル・トークン・生成物は流用しません。

## 比較（Phase 2 完了後に記入）

| 項目 | Phase 1（OpenAI公式SDK） | Phase 2（Pi SDK） |
| --- | --- | --- |
| SDK / バージョン | `openai` 7.32.0（Bun 1.3.14 / TypeScript 7.0.2） | 未記入 |
| 実際の認証方式 | OAuth 2.0 Authorization Code + PKCE(S256) / 動的登録（`dynamic_agent_client` → 発行済み `oaiapp_...`）、JWKS による ID トークン検証、`expires_in` から 60 秒前の自動更新、`revocation_endpoint` によるサインアウト | 未記入 |
| 使用モデル | `gpt-6-luna`（アカウントのカタログから選択。カタログは `{ models: [...] }` で 10 件中 `visibility: "list"` の 7 件） | 未記入 |
| 確認できた制約 | [openai-sdk/README.md](./openai-sdk/README.md) の「実測結果」「公式ドキュメント由来の制約」を参照 | 未記入 |
| エラーと再現手順 | [openai-sdk/README.md](./openai-sdk/README.md) の「失敗系の再現手順」を参照（401 / 期限切れ / 未対応フィールド / 途中切断は実測済み） | 未記入 |

## 共通の前提

- ローカル・単一ユーザーで実行し、外部ネットワークへ公開しない
- 実トークンをコンソール・ログ・HTTP レスポンス・ストリーム・Git・LLM 会話へ出さない
- 資格情報はリポジトリ外に置き、権限を制限する
