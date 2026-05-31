# backend-sse-chat-poc

Issue [#657](https://github.com/u7chan/monorepo/issues/657) 向けの PoC です。FastAPI をバックエンドのストリーム受信主体に置き、フロントエンドは SSE を購読して途中生成を表示します。

## Overview

- Backend: FastAPI, AsyncOpenAI, インメモリ会話ストア, SSE
- Frontend: Jinja2Templates, HTML, JavaScript, TailwindCSS (CDN)
- 構成: 単一プロセス / インメモリ保持 / Worker なし / Redis なし
- 復元: ページ再読み込み時に `GET /conversations/{conversation_id}/state` で最新状態を復元

## Features

- `GET /` で新規会話を作成して `/conversations/{conversation_id}` にリダイレクト
- `POST /conversations/{conversation_id}/messages` で user message / assistant placeholder / generation を作成
- バックエンドが OpenAI ストリームを受信し、メモリ状態へ逐次反映
- `GET /conversations/{conversation_id}/events` で `message_started` / `message_delta` / `message_completed` / `message_failed` を SSE 配信
- `GET /conversations/{conversation_id}/state` で会話状態と `last_event_id` を返却
- `Last-Event-ID` または `after` クエリにより、再接続時に未受信イベントを再配信

## Project structure

```text
projects/backend-sse-chat-poc/
|- src/backend_sse_chat_poc/main.py
|- src/backend_sse_chat_poc/service.py
|- src/backend_sse_chat_poc/store.py
|- src/backend_sse_chat_poc/llm.py
|- templates/chat.html
|- tests/test_main.py
|- Dockerfile
|- pyproject.toml
```

## Setup

このプロジェクトは uv で Python 自体を管理します。`.python-version` は `3.14` です。

```bash
cd projects/backend-sse-chat-poc
UV_CACHE_DIR=/tmp/uv-cache uv python install 3.14
UV_CACHE_DIR=/tmp/uv-cache uv sync
```

### Run with fake streaming

API キーがなくても PoC を確認できるよう、`OPENAI_API_KEY` 未設定時はフェイクストリーマーに自動フォールバックします。

```bash
cd projects/backend-sse-chat-poc
UV_CACHE_DIR=/tmp/uv-cache uv run uvicorn backend_sse_chat_poc.main:app --reload --host 0.0.0.0 --port 8000
```

### Run with OpenAI

```bash
cd projects/backend-sse-chat-poc
export OPENAI_API_KEY="..."
export OPENAI_MODEL="gpt-4.1-mini"
UV_CACHE_DIR=/tmp/uv-cache uv run uvicorn backend_sse_chat_poc.main:app --reload --host 0.0.0.0 --port 8000
```

Open the UI at <http://127.0.0.1:8000>.

## API

### `GET /`

新規会話を生成して `/conversations/{conversation_id}` にリダイレクトします。

### `GET /conversations/{conversation_id}`

Jinja2Templates で会話画面を返します。

### `POST /conversations/{conversation_id}/messages`

リクエスト:

```json
{
  "content": "SSE で途中生成を見せてください"
}
```

レスポンス例:

```json
{
  "conversation_id": "conversation-1",
  "user_message": {
    "id": "msg_...",
    "role": "user",
    "content": "SSE で途中生成を見せてください",
    "status": "completed"
  },
  "assistant_message": {
    "id": "msg_...",
    "role": "assistant",
    "content": "",
    "status": "queued"
  },
  "generation": {
    "id": "gen_...",
    "assistant_message_id": "msg_...",
    "status": "queued",
    "sequence": 0,
    "error": null
  }
}
```

### `GET /conversations/{conversation_id}/state`

会話の `messages` / `generations` / `last_event_id` を返します。フロントエンドは画面再読み込み時にこの内容で復元します。

### `GET /conversations/{conversation_id}/events`

SSE を返します。イベント例:

```text
id: 1
event: message_started
data: {"generation_id":"gen_1","message_id":"msg_a","status":"streaming","seq":0}

id: 2
event: message_delta
data: {"generation_id":"gen_1","message_id":"msg_a","seq":1,"delta":"こんにちは"}

id: 4
event: message_completed
data: {"generation_id":"gen_1","message_id":"msg_a","status":"completed","seq":2}
```

## Test

```bash
cd projects/backend-sse-chat-poc
UV_CACHE_DIR=/tmp/uv-cache uv run ruff format --check .
UV_CACHE_DIR=/tmp/uv-cache uv run ruff check .
UV_CACHE_DIR=/tmp/uv-cache uv run pytest -v
```

## Docker

Docker build は CI 用 `test` stage と実行用 `final` stage を持ちます。`COMMIT_HASH` build arg にも対応しています。

```bash
cd projects/backend-sse-chat-poc
docker build --target=test -t backend-sse-chat-poc:test .
docker build --target=final -t backend-sse-chat-poc:latest .
docker run --rm -p 8000:8000 -e OPENAI_API_KEY="$OPENAI_API_KEY" backend-sse-chat-poc:latest
```

## PoC constraints

- 状態保持は単一プロセスのメモリのみです
- プロセス再起動で会話・イベント履歴は消えます
- SSE は同一プロセス内の購読者にのみ配信されます
- ストリーム中断の厳密な再開はしておらず、会話状態復元と SSE の未受信イベント再送までを対象にしています
- 長期保存、排他制御、Worker 分離、Redis、DB は未対応です
