# LLM HTTP Examples

各社 Provider や API の挙動を手元で簡易確認するための HTTP サンプル置き場です。

## 方針

- ディレクトリは細かく分けず、`docs/llm/` 直下に置く
- ファイル名は `<provider>-<api>.http` を基本にする
- レスポンス例やメモは対応する `.md` を横に置く

規模が小さい間は、階層で整理するよりファイル名で判別できる方が探しやすいです。
`chat/` や `responses/` のようなディレクトリは、ファイル数が増えてから再導入すれば十分です。

## Files

- `openai-chat.http`: OpenAI Chat Completions
- `openai-responses.http`: OpenAI Responses API
- `gemini-chat.http`: Gemini OpenAI-compatible Chat Completions
- `xai-chat.http`: xAI Chat Completions
- `deepseek-chat.http`: DeepSeek Chat Completions
- `litellm-image-generation.http`: LiteLLM 経由の画像生成
- `litellm-image-generation-response.md`: 画像生成レスポンス例
