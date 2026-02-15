---
created: 2026-02-15
project: portfolio
version: v2
previous_version: 2026-02-15_portfolio_chat-refactoring_v1.md
status: ready
---

# チャット機能リファクタリング計画 v2

## 背景

v1計画では全体的なリファクタリングを定義したが、スコープが大きすぎるため、**型定義の統一に焦点を絞ったv2**として切り出す。

## 目的

型定義の重複を解消し、一貫性のある型システムを構築する。

## 制約（重要）

**UI構造・スタイルは一切修正しない。**

- JSX の構造変更は行わない
- CSS クラス（Tailwind）の変更は行わない
- コンポーネントの分割は行わない
- 表示ロジックはそのまま維持する

本計画は**型定義の移動・統一のみ**を対象とする。ビジュアル的な変更は一切伴わない。

- `src/types/index.ts` の Zod スキーマ
- `chat-main.tsx` (lines 127-156) のローカル型定義

これらを統合し、単一の信頼できる情報源（Single Source of Truth）を作る。

## 現在の型定義の分析

### 1. `src/types/index.ts`（Zod スキーマ）

```typescript
// 現在の構造
- UserMetadataSchema
- UserMessageSchema (role: 'user', content: string)
- AssistantMetadataSchema
- AssistantMessageSchema (role: 'assistant', content: string)
- SystemMessageSchema (role: 'system', content: string)
- MessageSchema (discriminatedUnion)
- ConversationSchema

// エクスポート
export type Conversation = z.infer<typeof ConversationSchema>
```

**問題点:**

- `UserMessageSchema.content` が `string` のみ（画像対応していない）
- `reasoningContent` が全メッセージ型に存在（不要）
- 画像コンテンツの型定義がない

### 2. `chat-main.tsx`（ローカル型定義）

```typescript
// lines 127-156
- MessageAssistant (role: 'assistant', content: string, reasoning_content?: string)
- MessageSystem (role: 'system', content: string)
- MessageUser (role: 'user', content: string | Array<TextContent | ImageContent>)
- Message (union型)
```

**問題点:**

- ファイル内でのみ使用されるローカル型
- API ペイロードと DB スキーマで別々の型を使っている
- `reasoning_content` の命名がスネークケース（他はキャメルケース）

## 実装計画

### Step 1: 新規ファイル作成 `src/types/chat.ts`

統合された型定義を配置する新しいファイル。

```typescript
import { z } from 'zod'

// ============================================
// ベース型（Zod スキーマ）
// ============================================

/** 画像コンテンツ */
export const ImageContentSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string(),
  }),
})

export type ImageContent = z.infer<typeof ImageContentSchema>

/** テキストコンテンツ */
export const TextContentSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})

export type TextContent = z.infer<typeof TextContentSchema>

// ============================================
// メッセージ型（Zod スキーマ）
// ============================================

export const UserMetadataSchema = z.object({
  model: z.string(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
})

export type UserMetadata = z.infer<typeof UserMetadataSchema>

export const UserMessageSchema = z.object({
  id: z.string().optional(),
  role: z.literal('user'),
  // 修正: string | Array<TextContent | ImageContent> に対応
  content: z.union([z.string(), z.array(z.union([TextContentSchema, ImageContentSchema]))]),
  metadata: UserMetadataSchema,
})

export type UserMessage = z.infer<typeof UserMessageSchema>

export const AssistantMetadataSchema = z.object({
  model: z.string(),
  finishReason: z.string().optional(),
  usage: z.object({
    completionTokens: z.number().optional(),
    promptTokens: z.number().optional(),
    totalTokens: z.number().optional(),
    reasoningTokens: z.number().optional(),
  }),
})

export type AssistantMetadata = z.infer<typeof AssistantMetadataSchema>

export const AssistantMessageSchema = z.object({
  id: z.string().optional(),
  role: z.literal('assistant'),
  content: z.string(),
  reasoningContent: z.string().optional(), // 修正: optional に変更
  metadata: AssistantMetadataSchema,
})

export type AssistantMessage = z.infer<typeof AssistantMessageSchema>

export const SystemMessageSchema = z.object({
  id: z.string().optional(),
  role: z.literal('system'),
  content: z.string(),
  metadata: z.object({}).optional(),
})

export type SystemMessage = z.infer<typeof SystemMessageSchema>

// 判別Union型
export const MessageSchema = z.discriminatedUnion('role', [
  UserMessageSchema,
  AssistantMessageSchema,
  SystemMessageSchema,
])

export type Message = z.infer<typeof MessageSchema>

// ============================================
// 会話型（Zod スキーマ）
// ============================================

export const ConversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  messages: z.array(MessageSchema),
})

export type Conversation = z.infer<typeof ConversationSchema>

// ============================================
// API 通信用の内部型
// ============================================

/** API リクエスト用のメッセージ型 */
export interface ChatMessageUser {
  role: 'user'
  content: string | Array<TextContent | ImageContent>
}

export interface ChatMessageAssistant {
  role: 'assistant'
  content: string
  reasoning_content?: string // API 形式に合わせてスネークケース
}

export interface ChatMessageSystem {
  role: 'system'
  content: string
}

export type ChatMessage = ChatMessageUser | ChatMessageAssistant | ChatMessageSystem

// ============================================
// API レスポンス型
// ============================================

export interface ChatCompletionResult {
  model: string
  finishReason: string
  message: {
    content: string
    reasoningContent: string
  }
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    reasoningTokens?: number
  } | null
}

// ============================================
// 型ガード関数
// ============================================

export function isUserMessage(message: Message): message is UserMessage {
  return message.role === 'user'
}

export function isAssistantMessage(message: Message): message is AssistantMessage {
  return message.role === 'assistant'
}

export function isSystemMessage(message: Message): message is SystemMessage {
  return message.role === 'system'
}

export function isImageContentArray(
  content: string | Array<TextContent | ImageContent>
): content is Array<TextContent | ImageContent> {
  return Array.isArray(content)
}
```

### Step 2: `src/types/index.ts` の修正

既存の型定義を新しいファイルから再エクスポートする形に変更。

```typescript
// Before
import { z } from 'zod'

const UserMetadataSchema = z.object({...})
// ... 全てのスキーマ定義 ...

export const ConversationSchema = z.object({...})
export type Conversation = z.infer<typeof ConversationSchema>

// After
export {
  // Schemas
  ConversationSchema,
  MessageSchema,
  UserMessageSchema,
  AssistantMessageSchema,
  SystemMessageSchema,
  UserMetadataSchema,
  AssistantMetadataSchema,
  ImageContentSchema,
  TextContentSchema,
  // Types
  type Conversation,
  type Message,
  type UserMessage,
  type AssistantMessage,
  type SystemMessage,
  type UserMetadata,
  type AssistantMetadata,
  type ImageContent,
  type TextContent,
  // API Types
  type ChatMessage,
  type ChatMessageUser,
  type ChatMessageAssistant,
  type ChatMessageSystem,
  type ChatCompletionResult,
  // Guards
  isUserMessage,
  isAssistantMessage,
  isSystemMessage,
  isImageContentArray,
} from './chat.js'
```

### Step 3: `chat-main.tsx` の型参照更新

**注意: このステップでは型参照のみを変更し、UI構造（JSX/CSS）は一切変更しない。**

#### 3.1 インポートの変更

```typescript
// Before
import type { Conversation } from '#/types'

// After
import type {
  Conversation,
  ChatMessage,
  ChatMessageUser,
  ChatMessageAssistant,
  ChatMessageSystem,
  ChatCompletionResult,
} from '#/types'
```

#### 3.2 ローカル型定義の削除（lines 127-156）

以下の型定義を削除:

```typescript
// 削除対象
;-MessageAssistant - MessageSystem - MessageUser - Message
```

#### 3.3 型参照の更新

コンポーネント内の型参照を新しい型に変更:

| 現在               | 変更後                 |
| ------------------ | ---------------------- |
| `Message`          | `ChatMessage`          |
| `MessageUser`      | `ChatMessageUser`      |
| `MessageAssistant` | `ChatMessageAssistant` |
| `MessageSystem`    | `ChatMessageSystem`    |

#### 3.4 `sendChatCompletion` の戻り値型

```typescript
// Before
const sendChatCompletion = async (...): Promise<{
  model: string
  finish_reason: string
  message: { content: string; reasoning_content: string }
  usage: {...} | null
} | null>

// After
const sendChatCompletion = async (...): Promise<ChatCompletionResult | null>
```

## 変更ファイル一覧

### 新規作成（1ファイル）

| ファイル            | 目的                 |
| ------------------- | -------------------- |
| `src/types/chat.ts` | 統合型定義の新規作成 |

### 修正（2ファイル）

| ファイル                                   | 変更内容                                 |
| ------------------------------------------ | ---------------------------------------- |
| `src/types/index.ts`                       | 新しいファイルからの再エクスポートに変更 |
| `src/client/components/chat/chat-main.tsx` | ローカル型定義削除、新しい型を参照       |

## 影響範囲と対応

### 型の互換性

- `Conversation` 型: 変更なし（互換性維持）
- `Message` 型: `reasoningContent` フィールドが optional に変更（影響小）
- `UserMessage.content`: `string | Array<...>` の union 型に変更（影響中）

### 修正が必要な箇所

1. **DB 保存時のメッセージ変換** (`chat-main.tsx` lines 351-383)
   - `reasoning_content` → `reasoningContent` に変更
   - メタデータ構造の調整

2. **メッセージ表示部分** (`chat-main.tsx` lines 564-579)
   - `Array.isArray()` チェックはそのまま使用可能
   - 型ガード関数 `isImageContentArray()` を使用しても良い

## 検証項目

### ビルド・型チェック

- [ ] `npm run typecheck` がエラーなく通過
- [ ] `npm run build` がエラーなく通過

### 機能検証（UI変更なし）

- [ ] 既存の会話データが正しく読み込まれる
- [ ] 新規メッセージが正しく保存される
- [ ] 画像付きメッセージが正しく処理される
- [ ] ストリーミング応答が正しく表示される
- [ ] マークダウンプレビューが機能する

### UI動作確認（リグレッションテスト）

- [ ] 入力エリアの見た目・動作が変更されていない
- [ ] メッセージ表示の見た目が変更されていない
- [ ] コピー・削除ボタンの動作が変更されていない
- [ ] 画像アップロードUIの見た目が変更されていない
- [ ] ダークモードでの表示が変更されていない

## 実装後の次のステップ

型定義の統一が完了したら、v3 以降で以下を計画:

1. `chat-utils.ts` の作成（ユーティリティ関数分離）
2. `chat-api.ts` の作成（API クライアント抽象化）
3. `useChat.ts` フックの作成
