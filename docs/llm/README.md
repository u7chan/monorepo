# LLM API の HTTP サンプル

このディレクトリには、各プロバイダーの API を手元で呼び出し、通常応答・ストリーミング・画像入力などの挙動を確認するための `.http` ファイルを置いています。日付入りのレスポンス記録は過去の実行結果であり、現在の実行用サンプルではありません。

## 実行前の準備

### 1. 環境変数ファイルを作る

リポジトリルートで次を実行します。

```bash
cp docs/llm/.env.example docs/llm/.env
```

`docs/llm/.env` は同じディレクトリの `.gitignore` で除外されています。API キーを `.env.example` や `.http` ファイルへ直接書かないでください。

### 2. 使用する値を設定する

試したいリクエストに必要な項目だけを設定します。

| 環境変数 | 使用箇所 |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI Chat Completions、Responses API |
| `GEMINI_API_KEY` | Gemini の OpenAI 互換 Chat Completions |
| `XAI_API_KEY` | xAI Chat Completions |
| `DEEPSEEK_API_KEY` | DeepSeek Chat Completions |
| `LITELLM_API_KEY` | LiteLLM 経由の Responses API、画像生成 |
| `LITELLM_BASE_URL` | LiteLLM 経由の Responses API と MCP |
| `LITELLM_URL` | LiteLLM 経由の画像生成 |
| `UPLOAD_IMAGE` | 画像入力に使うデータ URL |

`.http` ファイルは `{{$dotenv VARIABLE_NAME}}` 形式で `.env` の値を読み込みます。この記法に対応した HTTP クライアントから、試したいリクエスト単位で実行してください。

## モデル ID と提供状況

実行用の `.http` ファイルでは、各社が案内する後継モデルを使用します。廃止済みのモデル ID は、移行経緯を追えるように停止日と後継モデルをコメントで残しています。

モデルの提供状況は変わるため、実行できない場合は各社の公式情報を確認してください。

- [Gemini の廃止予定](https://ai.google.dev/gemini-api/docs/deprecations?hl=ja)
- [DeepSeek API の変更履歴](https://api-docs.deepseek.com/updates/)
- [OpenAI API の廃止情報](https://developers.openai.com/api/docs/deprecations)

## サンプル一覧

| ファイル | 確認できる内容 |
| --- | --- |
| [`openai-chat.http`](./openai-chat.http) | OpenAI Chat Completions、ストリーミング、画像入力、Web 検索 |
| [`openai-responses.http`](./openai-responses.http) | OpenAI Responses API、ストリーミング、LiteLLM MCP の試行 |
| [`gemini-chat.http`](./gemini-chat.http) | `gemini-3.6-flash` の OpenAI 互換 Chat Completions |
| [`xai-chat.http`](./xai-chat.http) | xAI Chat Completions |
| [`deepseek-chat.http`](./deepseek-chat.http) | `deepseek-v4-flash` の Chat Completions |
| [`litellm-image-generation.http`](./litellm-image-generation.http) | LiteLLM 経由で行う `gpt-image-2` の画像生成 |
| [`litellm-image-generation-response-2026-01.md`](./litellm-image-generation-response-2026-01.md) | 2026年1月に取得した画像生成レスポンスの履歴 |

## ファイルの整理方針

- `.http` ファイルは `docs/llm/` 直下に置く
- ファイル名は `<provider>-<api>.http` を基本とする
- レスポンス例や補足は、対応する `.md` ファイルを同じ階層に置く
- 過去のレスポンス記録には、採取時期が分かる日付をファイル名に付ける
- ファイル数が少ない間は、API 種別ごとのサブディレクトリを作らない

ファイル名だけでは探しにくくなった時点で、`chat/` や `responses/` などのサブディレクトリへの分割を検討します。

## サンプルを更新するときの注意

- API キー、署名付き URL、利用者を特定できる値を残さない
- リクエストの前提となる環境変数を `.env.example` に追加する
- モデル ID の提供状況を公式情報で確認し、廃止済みモデルを実行用リクエストに残さない
- モデルを移行した場合は、旧モデル ID、停止日、後継モデルをコメントに残す
- 未対応または実行できなかったリクエストには、その状態と確認できた範囲を見出しへ記録する
- レスポンス例は採取時点の記録として扱い、現在の応答を保証する説明にしない
