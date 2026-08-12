import type { Settings } from '#/client/shared/storage/remote-storage-settings'
import type { ChatError } from '#/types/chat-api'

interface ValidateChatSettingsOptions {
  allowFakeMode?: boolean
}

export function validateChatSettings(
  settings: Pick<Settings, 'baseURL' | 'apiKey' | 'fakeMode'>,
  { allowFakeMode = false }: ValidateChatSettingsOptions = {}
): ChatError | null {
  if (allowFakeMode && settings.fakeMode) {
    return null
  }

  if (!settings.baseURL.trim() || !settings.apiKey.trim()) {
    return {
      code: 'VALIDATION_ERROR',
      message: 'Base URL と API Key を設定してください。',
      retryable: false,
    }
  }

  try {
    new URL(settings.baseURL.trim())
  } catch {
    return {
      code: 'VALIDATION_ERROR',
      message: '有効な Base URL を設定してください。',
      retryable: false,
    }
  }

  return null
}
