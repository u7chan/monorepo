---
created: 2026-02-15
project: portfolio
version: v1
previous_version: null
status: ready
---

# チャット機能リファクタリング計画

## 背景と目的

現在のチャット実装は以下のファイルで構成されていますが、複雑性が高まっています：

- `chat-main.tsx` (1,056行) - UI、状態管理、API呼び出し、ビジネスロジックが混在
- `chat-settings.tsx` (338行) - 設定UIと状態管理
- `index.tsx` (196行) - ページコンテナ

### 主な問題

1. **Cognitive Complexity**: `sendChatCompletion` 関数がストリーミング/非ストリーミング両方を処理し、複雑な入れ子条件分岐が存在（line 916に TODO: [!] Cognitive Complexity コメントあり）
2. **巨大なコンポーネント**: ChatMain が1,056行で責任が多すぎる
3. **状態の重複**: メッセージと設定が複数箇所で保持されている
   - `Chat` page state と `ChatMain` local state の両方に messages がある
   - Settings は localStorage、lifted state、個別コンポーネント state の3箇所
4. **型の重複**: ZodスキーマとTypeScriptインターフェースが別々に定義
5. **Prop Drilling**: 設定とコールバックが多層に渡されている

## 推奨リファクタリング案

### Phase 1: 型定義の統一と標準化

**新規ファイル**: `src/types/chat.ts`

現在の問題：
- `src/types/index.ts` に Zod スキーマがある
- `chat-main.tsx` に重複する TypeScript インターフェースがある（lines 127-156）

統合案：
```typescript
// src/types/chat.ts
import { z } from 'zod'
import { MessageSchema, ConversationSchema } from './index.js'

export type Message = z.infer<typeof MessageSchema>
export type Conversation = z.infer<typeof ConversationSchema>

// ChatMain で使用される内部用型も統合
export type MessageRole = 'user' | 'assistant' | 'system'

export interface ChatMessageUser {
  role: 'user'
  content: string | Array<TextContent | ImageContent>
}

export interface ChatMessageAssistant {
  role: 'assistant'
  content: string
  reasoning_content?: string
}

export interface ChatMessageSystem {
  role: 'system'
  content: string
}

export type ChatMessage = ChatMessageUser | ChatMessageAssistant | ChatMessageSystem
```

### Phase 2: ユーティリティ関数の分離

**新規ファイル**: `src/client/lib/chat-utils.ts`

純粋関数として分離：
```typescript
// クリップボード操作
export async function copyToClipboard(text: string): Promise<void>

// メッセージ作成ヘルパー
export function createUserMessage(
  text: string,
  uploadImages: string[]
): ChatMessageUser

export function createSystemMessage(content: string): ChatMessageSystem

export function createAssistantMessage(
  content: string,
  reasoningContent?: string
): ChatMessageAssistant

// テキストエリア行数計算
export function calculateTextRows(
  text: string,
  minRows: number,
  maxRows: number
): number
```

### Phase 3: APIクライアントの抽象化

**新規ファイル**: `src/client/lib/chat-api.ts`

現在の問題：
- `chat-main.tsx` lines 873-1055 に埋め込まれた `sendChatCompletion` 関数（183行）
- ストリーミング処理と非ストリーミング処理が混在

分離案：
```typescript
// src/client/lib/chat-api.ts
export interface ChatStreamCallbacks {
  onChunk: (chunk: { content: string; reasoning_content?: string }) => void
  onComplete: (result: ChatCompletionResult) => void
  onError: (error: Error) => void
}

export interface ChatCompletionParams {
  abortController: AbortController
  header: {
    apiKey: string
    baseURL: string
    mcpServerURLs: string
  }
  model: string
  messages: ChatMessage[]
  stream: boolean
  temperature?: number
  maxTokens?: number
}

export interface ChatCompletionResult {
  model: string
  finish_reason: string
  message: {
    content: string
    reasoning_content: string
  }
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    reasoningTokens?: number
  } | null
}

export class ChatAPIClient {
  private client: ReturnType<typeof hc<AppType>>

  constructor()

  // 非ストリーミング送信
  async sendMessage(
    params: ChatCompletionParams
  ): Promise<ChatCompletionResult | null>

  // ストリーミング送信
  async sendMessageStream(
    params: ChatCompletionParams,
    callbacks: ChatStreamCallbacks
  ): Promise<void>

  // レスポンス処理の内部メソッド
  private parseNonStreamingResponse(response: Response): Promise<ChatCompletionResult>
  private parseStreamingResponse(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    callbacks: ChatStreamCallbacks
  ): Promise<void>
}
```

### Phase 4: カスタムフックの導入

**新規ファイル**: `src/client/hooks/useChat.ts`

```typescript
// src/client/hooks/useChat.ts
export interface UseChatOptions {
  settings: Settings
  currentConversation?: Conversation | null
  onConversationChange?: (conversation: Conversation) => void
  onDeleteMessages?: (messageIds: string[], isConversationEmpty: boolean) => void
}

export interface UseChatReturn {
  // 状態
  messages: ChatMessage[]
  isLoading: boolean
  isStreaming: boolean
  streamContent: { content: string; reasoning_content?: string } | null
  chatResults: ChatCompletionResult | null
  input: string
  textAreaRows: number
  uploadImages: string[]

  // アクション
  sendMessage: (text: string, templateInput?: TemplateInput) => Promise<void>
  cancelStream: () => void
  deleteMessagePair: (index: number) => void
  resetChat: () => void
  handleInputChange: (value: string) => void
  handleImageChange: (src: string, index?: number) => void
}

export function useChat(options: UseChatOptions): UseChatReturn
```

**新規ファイル**: `src/client/hooks/useConversations.ts`

```typescript
// src/client/hooks/useConversations.ts
export interface UseConversationsReturn {
  conversations: Conversation[]
  currentConversationId: string | null
  currentConversation: Conversation | null
  isLoading: boolean

  createConversation: (conversation: Conversation) => Promise<void>
  updateConversation: (conversation: Conversation) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  deleteMessages: (messageIds: string[]) => Promise<void>
  selectConversation: (id: string | null) => void
  refresh: () => void
}

export function useConversations(): UseConversationsReturn
```

### Phase 5: Settings Provider の導入

**新規ファイル**: `src/client/contexts/SettingsContext.tsx`

Prop Drilling を解消：
```typescript
// SettingsContext で一元管理
interface SettingsContextType {
  settings: Settings
  updateSettings: (partial: Partial<Settings>) => void
  resetSettings: () => void
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined)

export function SettingsProvider({ children }: { children: React.ReactNode })
export function useSettings(): SettingsContextType
```

### Phase 6: コンポーネントの分割

**chat-main.tsx の分割案**：

```
src/client/components/chat/
├── chat-main.tsx           # メインコンテナ（200行程度に簡略化）
├── chat-message-list.tsx   # メッセージ一覧表示
├── chat-message.tsx        # 個別メッセージ（User/Assistant）
├── chat-input-area.tsx     # 入力エリア（画像アップロード含む）
├── chat-empty-state.tsx    # 空状態表示（PromptTemplate含む）
└── chat-streaming.tsx      # ストリーミング表示
```

**各コンポーネントの責任**：

1. **chat-message-list.tsx**: メッセージリストの表示、スクロール管理
2. **chat-message.tsx**: 個別メッセージの表示、コピー/削除アクション
3. **chat-input-area.tsx**: テキスト入力、画像アップロード、送信ボタン
4. **chat-empty-state.tsx**: 初期状態表示、テンプレート選択
5. **chat-streaming.tsx**: ストリーミング中の表示、Markdownレンダリング

## 実装順序（推奨）

```
Step 1: 型定義の統一 (src/types/chat.ts)
   ↓
Step 2: ユーティリティ関数の分離 (src/client/lib/chat-utils.ts)
   ↓
Step 3: APIクライアントの抽象化 (src/client/lib/chat-api.ts)
   ↓
Step 4: useChat フックの作成
   ↓
Step 5: useConversations フックの作成
   ↓
Step 6: SettingsContext の作成
   ↓
Step 7: ChatMain の分割（小さなコンポーネントに）
   ↓
Step 8: 既存コードの整理と削除
```

## 変更予定ファイル一覧

### 新規作成（10ファイル）
| ファイル | 目的 |
|---------|------|
| `src/types/chat.ts` | 統合型定義 |
| `src/client/lib/chat-api.ts` | APIクライアント |
| `src/client/lib/chat-utils.ts` | ユーティリティ関数 |
| `src/client/hooks/useChat.ts` | チャット状態フック |
| `src/client/hooks/useConversations.ts` | 会話管理フック |
| `src/client/contexts/SettingsContext.tsx` | 設定コンテキスト |
| `src/client/components/chat/chat-message-list.tsx` | メッセージリスト |
| `src/client/components/chat/chat-message.tsx` | 個別メッセージ |
| `src/client/components/chat/chat-input-area.tsx` | 入力エリア |
| `src/client/components/chat/chat-empty-state.tsx` | 空状態表示 |

### 修正（4ファイル）
| ファイル | 変更内容 |
|---------|---------|
| `src/client/components/chat/chat-main.tsx` | 1,056行 → 200行程度に簡略化 |
| `src/client/pages/chat/index.tsx` | フック使用に変更 |
| `src/client/components/chat/chat-settings.tsx` | Context使用に変更 |
| `src/types/index.ts` | 型定義を chat.ts に移動 |

## 期待される効果

| 項目 | 現在 | リファクタ後 |
|-----|------|-----------|
| chat-main.tsx | 1,056行 | ~200行 |
| sendChatCompletion | 183行（複雑） | APIClient内に分離 |
| 状態管理 | 分散 | フック/Contextで一元化 |
| 型定義 | 重複あり | 一元化 |
| Prop Drilling | 多い | 解消 |

### 品質向上
1. **保守性**: 責任が明確に分離される
2. **テスト容易性**: 純粋関数とフックが分離され、ユニットテストが書きやすくなる
3. **再利用性**: フックとユーティリティが他の場所でも使える
4. **可読性**: 各ファイルの行数が減少し、理解しやすくなる
5. **型安全性**: 型定義が一元化され、矛盾がなくなる

## リスクと対策

| リスク | 対策 |
|-------|------|
| 機能のリグレッション | 各Phase後に手動テスト、最終的にE2Eテスト追加 |
| 型エラー | Step 1で型定義を完全に統合してから実装 |
| API動作の変更 | ChatAPIClientの単体テストを追加 |

## 検証方法

### 1. 既存機能の動作確認
- [ ] メッセージ送信（ストリーミング）
- [ ] メッセージ送信（非ストリーミング）
- [ ] 画像アップロード機能
- [ ] 会話の保存
- [ ] 会話の読み込み
- [ ] 会話の削除
- [ ] メッセージの削除（ペア）
- [ ] 設定の変更と永続化
- [ ] Fake Mode動作
- [ ] ストリーミングキャンセル

### 2. ビルド確認
```bash
cd /workspaces/monorepo/projects/portfolio
npm run typecheck
npm run build
```

### 3. コード品質確認
- [ ] ESLint エラーなし
- [ ] 型エラーなし
- [ ] 循環参照なし
