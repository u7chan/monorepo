---
created: 2026-02-16
project: portfolio
version: v1
previous_version: null
status: draft
---

# reasoning_effort GUI設定の実装プラン

## Context

OpenAI API (およびLiteLLM経由) の推論モデルでは、`reasoning_effort` パラメータを使って推論の努力度を制御できる。このパラメータは現在 `chat.ts` で `undefined` としてハードコードされており、ユーザーがGUIから設定できない。

値: `undefined` (UIでは空文字) | `'none'` | `'minimal'` | `'low'` | `'medium'` | `'high'` | `'xhigh'`

- デフォルト: `undefined` (モデル側のデフォルトを使用)

## 変更対象ファイル

### 1. サーバー側 - API定義と型

#### `src/server/app.tsx` (L84-L95)

- Zodスキーマに `reasoning_effort` を追加
- `z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional()` とする

```typescript
z.object({
  messages: MessageSchema.array(),
  model: z.string().min(1),
  stream: z.boolean().default(false),
  temperature: z.number().min(0).max(1).optional(),
  max_tokens: z.number().min(1).optional(),
  reasoning_effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(), // 追加
  stream_options: z.object({...}).optional(),
})
```

#### `src/server/features/chat/chat.ts` (L64-L158)

- `Chat` interfaceのparamsに `reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'` を追加
- `completions` 関数のパラメータで `reasoningEffort` を受け取る
- `openai.chat.completions.create` の呼び出しで `reasoning_effort: reasoningEffort` を設定

### 2. クライアント側 - 設定UI

#### `src/client/storage/remote-storage-settings.ts`

- `Settings` interfaceに追加:
  - `reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'`
  - `reasoningEffortEnabled?: boolean`
- `defaultSettings` に追加:
  - `reasoningEffort: undefined`
  - `reasoningEffortEnabled: false`

#### `src/client/components/chat/chat-settings.tsx`

- 既存の `temperatureEnabled` / `temperature` と同じパターンで実装
- `ToggleInput` + `select` ドロップダウンの組み合わせ
- 追加位置: Max Tokens の下あたり

### 3. クライアント側 - API送信

#### `src/client/components/chat/chat-main.tsx` (L846-L859, L878-L896)

- `sendChatCompletion` 関数の `req` 型に `reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'` を追加
- API呼び出し時に `reasoning_effort` をjsonボディに含める
- `handleSubmit` 内の `form` オブジェクトに `reasoningEffort` を追加
- `sendChatCompletion` 呼び出し時に `reasoningEffort` を渡す

### 4. 型生成

```bash
bun run typegen
```

これにより `src/server/app.d.ts` が自動更新され、Hono RPCのクライアント型が正しく機能する。

## 実装ステップ

1. **サーバー側の型定義** (`app.tsx`, `chat.ts`)
2. **localStorage設定** (`remote-storage-settings.ts`)
3. **設定UI** (`chat-settings.tsx`)
4. **API送信** (`chat-main.tsx`)
5. **型生成** (`bun run typegen`)

## 動作確認手順

1. 開発サーバーを起動
2. Chat Settingsを開く
3. "Reasoning Effort" トグルが表示されることを確認
4. トグルをONにして、ドロップダウンから値を選択
5. チャット送信
6. ネットワークタブでリクエストボディに `reasoning_effort` が含まれていることを確認

## 参考: reasoning_effort 値

| 値               | 説明                     |
| ---------------- | ------------------------ |
| `undefined` (空) | モデルのデフォルトを使用 |
| `none`           | 推論を無効化             |
| `minimal`        | 最小限の推論             |
| `low`            | 低い推論努力             |
| `medium`         | 中程度の推論努力         |
| `high`           | 高い推論努力             |
| `xhigh`          | 最大限の推論努力         |

モデルやAPIプロバイダーによってサポートされる値は異なる場合があります。
