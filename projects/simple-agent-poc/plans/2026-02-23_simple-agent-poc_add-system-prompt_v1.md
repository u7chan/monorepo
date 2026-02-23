---
created: 2026-02-23
project: simple-agent-poc
version: v1
previous_version: null
status: ready
---

# AIエージェントのシステムプロンプト仕様 - 実装計画

## コンテキスト

現在の`Agent`クラスはシステムプロンプトを持たず、単純なユーザー/アシスタントの会話のみをサポートしている。より柔軟なエージェント動作のため、システムプロンプトを外部から注入可能にし、動的な日時情報を含める必要がある。

## 実装方針

### 1. types.pyの拡張

**変更内容:**
- `MessageRole`型に `"system"` を追加
- エージェント設定用の型定義を追加（オプション）

**理由:**
- LiteLLMはシステムメッセージをサポートしており、標準的なLLM機能として必要

### 2. agent.pyの拡張

**変更内容:**
- `__init__`に以下のパラメータを追加:
  - `system_prompt: str | None = None` - カスタムシステムプロンプト
  - `model: str = "gpt-4.1-nano"` - モデル名（外部注入用）
- デフォルトシステムプロンプトをクラス定数として定義
- `{current_datetime}`プレースホルダーを現在日時で置換する処理を追加
- システムメッセージを`_messages`の先頭に追加

**デフォルトシステムプロンプト:**
```python
DEFAULT_SYSTEM_PROMPT = """You are an AI assistant designed to help users with various tasks.

Guidelines:
1. Be helpful, accurate, and concise
2. Provide clear explanations when needed
3. Admit when you don't know something
4. Maintain a professional and friendly tone
5. Use the current temporal context ({current_datetime}) when relevant to the user's query.
"""
```

### 3. llm_client.pyの拡張（オプション）

**変更内容:**
- `temperature`や`max_tokens`等のパラメータを`__init__`で受け取れるようにする（必要に応じて）

**判断基準:**
- 現時点では必須ではない。今後の拡張として検討。

### 4. テストの追加

**追加テストケース:**
- デフォルトシステムプロンプトが正しく設定されること
- カスタムシステムプロンプトが適用されること
- `{current_datetime}`プレースホルダーが正しく置換されること
- システムメッセージが会話履歴の先頭に含まれること

## 変更対象ファイル

1. `src/simple_agent_poc/types.py` - MessageRoleに"system"を追加
2. `src/simple_agent_poc/agent.py` - システムプロンプト機能の実装
3. `tests/test_agent.py` - 新機能のテスト追加

## 実装コードの概要

```python
# agent.py
from datetime import datetime

class Agent:
    DEFAULT_SYSTEM_PROMPT = """..."""

    def __init__(
        self,
        llm_client: LLMClient | None = None,
        system_prompt: str | None = None,
        model: str = "gpt-4.1-nano",
    ) -> None:
        self._client = llm_client or LiteLLMClient(model=model)
        self._messages: list[Message] = []
        self._system_prompt = system_prompt or self.DEFAULT_SYSTEM_PROMPT
        self._initialize_system_message()

    def _initialize_system_message(self) -> None:
        """システムメッセージを初期化（現在日時を埋め込む）"""
        current_datetime = datetime.now().isoformat()
        formatted_prompt = self._system_prompt.format(current_datetime=current_datetime)
        self._messages.append({"role": "system", "content": formatted_prompt})

    def process_user_input(self, user_input: str) -> LLMResponse:
        self._messages.append({"content": user_input, "role": "user"})
        response = self._client.complete(self._messages)
        self._messages.append({"content": response["content"], "role": "assistant"})
        return response
```

## 検証方法

1. 既存テストが全て通過すること
2. 新規テストケースが通過すること
3. 手動実行でシステムプロンプトがLLMに正しく送信されることを確認

```bash
# テスト実行
uv run pytest tests/test_agent.py -v
```
