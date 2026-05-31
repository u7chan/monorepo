# google-adk-example

## 起動

```sh
GEMINI_API_KEY=... uv run adk web
```

## API メモ

FastAPI: <http://localhost:8000/docs>

### 会話の流れ

1. GET `/list-apps` でエージェント一覧を取得
1. POST `/apps/hello_agent/users/test/sessions` でチャットのセッションを開始
1. POST `/run_sse` でエージェントとチャット

### API List

#### /list-apps

-->

```sh
curl -X 'GET' \
  'http://localhost:8000/list-apps' \
  -H 'accept: application/json'
```

<--

```sh
[
  "hello_agent"
]
```

#### /session

-->

```sh
curl -X 'POST' \
  'http://localhost:8000/apps/hello_agent/users/test/sessions' \
  -H 'accept: application/json' \
  -H 'Content-Type: application/json' \
  -d '{}'
```

<--

```sh
{
  "id": "1203f758-60e3-4701-9ae2-3ca081f9b6ac",
  "appName": "hello_agent",
  "userId": "test",
  "state": {},
  "events": [],
  "lastUpdateTime": 1750939128.1245198
}
```

#### /run_sse

-->

```sh
curl -X 'POST' \
  'http://localhost:8000/run_sse' \
  -H 'accept: application/json' \
  -H 'Content-Type: application/json' \
  -d '{
  "appName": "hello_agent",
  "userId": "test",
  "sessionId": "1203f758-60e3-4701-9ae2-3ca081f9b6ac",
  "newMessage": {
    "parts": [
      {
        "text": "こんにちは"
      }
    ],
    "role": "user"
  },
  "streaming": true
}'
```

<--

```sh
data: {"content":{"parts":[{"text":"こんにちは"}],"role":"model"},"partial":true,"usageMetadata":{"promptTokenCount":483,"promptTokensDetails":[{"modality":"TEXT","tokenCount":483}],"totalTokenCount":483},"invocationId":"e-d532929c-9616-44da-97b5-311e8a8dd89b","author":"shiritori","actions":{"stateDelta":{},"artifactDelta":{},"requestedAuthConfigs":{}},"id":"Q5CvtTmf","timestamp":1750939268.218085}

data: {"content":{"parts":[{"text":"！しりとりをしましょう！\n\nまず、最初の単語「string」ですね。"}],"role":"model"},"partial":true,"usageMetadata":{"promptTokenCount":483,"promptTokensDetails":[{"modality":"TEXT","tokenCount":483}],"totalTokenCount":483},"invocationId":"e-d532929c-9616-44da-97b5-311e8a8dd89b","author":"shiritori","actions":{"stateDelta":{},"artifactDelta":{},"requestedAuthConfigs":{}},"id":"wTVuuEyI","timestamp":1750939268.218085}

data: {"content":{"parts":[{"text":"プログラミング用語ですね！\n\nそれでは、しりとりを始めるにあたって、簡単な"}],"role":"model"},"partial":true,"usageMetadata":{"promptTokenCount":483,"promptTokensDetails":[{"modality":"TEXT","tokenCount":483}],"totalTokenCount":483},"invocationId":"e-d532929c-9616-44da-97b5-311e8a8dd89b","author":"shiritori","actions":{"stateDelta":{},"artifactDelta":{},"requestedAuthConfigs":{}},"id":"iesb5QJF","timestamp":1750939268.218085}

data: {"content":{"parts":[{"text":"ルール説明です。\n\n- 一度使った単語は使えません。\n- 単語の最後が「ん」で終わったら負けです。\n\n"}],"role":"model"},"partial":true,"usageMetadata":{"promptTokenCount":483,"promptTokensDetails":[{"modality":"TEXT","tokenCount":483}],"totalTokenCount":483},"invocationId":"e-d532929c-9616-44da-97b5-311e8a8dd89b","author":"shiritori","actions":{"stateDelta":{},"artifactDelta":{},"requestedAuthConfigs":{}},"id":"cIFnKOM6","timestamp":1750939268.218085}

data: {"content":{"parts":[{"text":"では、私が最初の単語を選びますね。\n\n「ごりら」\n\nさあ、あなたの番です！\n"}],"role":"model"},"partial":true,"usageMetadata":{"candidatesTokenCount":87,"candidatesTokensDetails":[{"modality":"TEXT","tokenCount":87}],"promptTokenCount":453,"promptTokensDetails":[{"modality":"TEXT","tokenCount":453}],"totalTokenCount":540},"invocationId":"e-d532929c-9616-44da-97b5-311e8a8dd89b","author":"shiritori","actions":{"stateDelta":{},"artifactDelta":{},"requestedAuthConfigs":{}},"id":"cZ5maCM2","timestamp":1750939268.218085}

data: {"content":{"parts":[{"text":"こんにちは！しりとりをしましょう！\n\nまず、最初の単語「string」ですね。プログラミング用語ですね！\n\nそれでは、しりとりを始めるにあたって、簡単なルール説明です。\n\n- 一度使った単語は使えません。\n- 単語の最後が「ん」で終わったら負けです。\n\nでは、私が最初の単語を選びますね。\n\n「ごりら」\n\nさあ、あなたの番です！\n"}],"role":"model"},"usageMetadata":{"candidatesTokenCount":87,"candidatesTokensDetails":[{"modality":"TEXT","tokenCount":87}],"promptTokenCount":453,"promptTokensDetails":[{"modality":"TEXT","tokenCount":453}],"totalTokenCount":540},"invocationId":"e-d532929c-9616-44da-97b5-311e8a8dd89b","author":"shiritori","actions":{"stateDelta":{},"artifactDelta":{},"requestedAuthConfigs":{}},"id":"3ZMqJM8h","timestamp":1750939268.218085}

```
