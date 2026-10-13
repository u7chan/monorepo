# sign-in-with-chatgpt-poc

Epic [#1935](https://github.com/u7chan/monorepo/issues/1935) の PoC を 2 段階で検証するための置き場です。
どちらのサンプルも単独で起動・動作し、互いの生成物やトークンに依存しません。

```text
projects/_labs/sign-in-with-chatgpt-poc/
├── openai-sdk/   # Phase 1: OpenAI公式SDK + SIWC（#1936）
├── pi-sdk/       # Phase 2: Pi SDK + SIWC（#1937）
└── README.md
```

## Phase 1: OpenAI公式SDK + SIWC

`openai` SDK の Bearer 認証に SIWC の OAuth アクセストークンを使い、公開 Responses API をストリーミングで呼びます。
実行手順・前提条件・実測結果・制約は [openai-sdk/README.md](./openai-sdk/README.md) にあります。

## Phase 2: Pi SDK + SIWC

`@earendil-works/pi-coding-agent` の組み込み SIWC OAuth（`openai` provider）を使い、最小のエージェントセッションで推論・ツール実行・トークン更新まで確認します。
実行手順・前提条件・実測結果・制約は [pi-sdk/README.md](./pi-sdk/README.md) にあります。

## 比較

| 項目 | Phase 1（OpenAI公式SDK） | Phase 2（Pi SDK） |
| --- | --- | --- |
| SDK / バージョン | `openai` 7.32.0（Bun 1.3.14 / TypeScript 7.0.2） | `@earendil-works/pi-coding-agent` 1.2.0（Bun 1.3.14 / TypeScript 7.0.2） |
| 実際の認証方式 | OAuth 2.0 Authorization Code + PKCE(S256) / 動的登録（`dynamic_agent_client` → 発行済み `oaiapp_...`）、JWKS による ID トークン検証、`expires_in` から 60 秒前の自動更新、`revocation_endpoint` によるサインアウト | Pi 組み込みの SIWC OAuth（同じ動的登録と `oaiapp_...`）。`ModelRuntime.login("openai", "oauth")` に委譲し、期限の 3 分前に自動更新。logout はローカル削除のみで provider 側は失効させない |
| 使用モデル | `gpt-6-luna`（アカウントのカタログから選択。カタログは `{ models: [...] }` で 10 件中 `visibility: "list"` の 7 件） | `gpt-6-luna`（Pi 同梱の `openai` カタログは 44 チャットモデル。SIWC のアカウント別カタログは見ない） |
| 推論経路 | `https://api.openai.com/v1/responses`・`store: false` / `stream: true` | 同じ。加えて `prompt_cache_key`、reasoning 時は `reasoning` + `include: ["reasoning.encrypted_content"]`。SIWC 未対応フィールドは provider 実装が落とす |
| エージェント機能 | なし（素の SDK） | ツール呼び出し（`bash`）、会話継続、セッション、拡張フック。SDK 改変なしで動く |
| 確認できた制約 | [openai-sdk/README.md](./openai-sdk/README.md) の「実測結果」「公式ドキュメント由来の制約」を参照 | [pi-sdk/README.md](./pi-sdk/README.md) の「実測結果」「Pi 実装由来の制約」を参照 |
| エラーと再現手順 | [openai-sdk/README.md](./openai-sdk/README.md) の「失敗系の再現手順」を参照（401 / 期限切れと更新 / ログアウト / 未対応フィールド / 途中切断は実測済み） | [pi-sdk/README.md](./pi-sdk/README.md) の「失敗系の再現手順」を参照（401 / 期限切れと更新 / ログアウト / 資格情報の継承は実測済み。403 / 429 / `response.failed` / 途中切断は未検証） |

## 共通の前提

- ローカル・単一ユーザーで実行し、外部ネットワークへ公開しない
- 実トークンをコンソール・ログ・HTTP レスポンス・ストリーム・Git・LLM 会話へ出さない
- 資格情報はリポジトリ外に置き、権限を制限する
