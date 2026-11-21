import { uuidv7 } from 'uuidv7'
import type { Conversation, Message } from '#/types'

type SessionOwnedSnapshot = Pick<Conversation, 'id' | 'messages'>

export interface BeginChatTurnArgs {
  conversationId: string | null
  title: string
  messages: Message[]
  markSessionOwnedSnapshot: (conversation: SessionOwnedSnapshot) => void
  setConversationId: (conversationId: string) => void
  setMessages: (messages: Message[]) => void
  setStreamMessageId: (messageId: string) => void
}

export interface StartedChatTurn {
  conversationId: string
  assistantMessageId: string
  draftConversation: Conversation
}

/**
 * 送信・編集・画像生成で共通の「下書き会話を確定して生成中にする」手順。
 * 会話 ID と snapshot の更新順は、保存処理が古い snapshot を掴まないために固定している。
 */
export function beginChatTurn({
  conversationId,
  title,
  messages,
  markSessionOwnedSnapshot,
  setConversationId,
  setMessages,
  setStreamMessageId,
}: BeginChatTurnArgs): StartedChatTurn {
  const assistantMessageId = uuidv7()
  const nextConversationId = conversationId || uuidv7()
  const draftConversation: Conversation = {
    id: nextConversationId,
    title,
    messages,
  }

  markSessionOwnedSnapshot(draftConversation)
  setConversationId(nextConversationId)
  setMessages(messages)
  setStreamMessageId(assistantMessageId)

  return { conversationId: nextConversationId, assistantMessageId, draftConversation }
}

export interface CompleteChatTurnArgs {
  conversation: Pick<Conversation, 'id' | 'title'>
  messages: Message[]
  useSessionCompletion: boolean
  markSessionOwnedSnapshot: (conversation: SessionOwnedSnapshot) => void
  setMessages: (messages: Message[]) => void
  setIsSavingConversation: (isSaving: boolean) => void
  onConversationChange?: (conversation: Conversation) => Promise<void> | void
  onSessionCompleted?: (conversation: Conversation) => Promise<void> | void
}

/**
 * アシスタント応答を反映して会話を保存する。
 * 保存中フラグの解除は保存経路の成否に関わらず必要なので finally に寄せている。
 */
export async function completeChatTurn({
  conversation,
  messages,
  useSessionCompletion,
  markSessionOwnedSnapshot,
  setMessages,
  setIsSavingConversation,
  onConversationChange,
  onSessionCompleted,
}: CompleteChatTurnArgs): Promise<void> {
  const completedConversation: Conversation = {
    id: conversation.id,
    title: conversation.title,
    messages,
  }

  markSessionOwnedSnapshot({ id: completedConversation.id, messages })
  setMessages(messages)
  setIsSavingConversation(true)
  try {
    if (useSessionCompletion) {
      await onSessionCompleted?.(completedConversation)
    } else {
      await onConversationChange?.(completedConversation)
    }
  } finally {
    setIsSavingConversation(false)
  }
}
