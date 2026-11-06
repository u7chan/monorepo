// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '#/client/shared/storage/remote-storage-settings'

const STORAGE_KEY = 'portfolio.chat-settings'

const useModelFetchingMock = vi.hoisted(() => vi.fn())
const useImageGenerationModelMock = vi.hoisted(() => vi.fn())

vi.mock('#/client/features/chat/components/chat-settings/hooks/use-model-fetching', () => ({
  useModelFetching: useModelFetchingMock,
}))

vi.mock('#/client/features/chat/hooks/use-image-generation-model', () => ({
  useImageGenerationModel: useImageGenerationModelMock,
}))

vi.mock('#/client/shared/hooks/use-lock-body-scroll', () => ({
  useLockBodyScroll: vi.fn(),
}))

import { ChatSettings } from '#/client/features/chat/components/chat-settings'

const createLocalStorageMock = (initialEntries: Record<string, string> = {}) => {
  const store = new Map(Object.entries(initialEntries))

  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
  }
}

const settings: Settings = {
  schemaVersion: '1.5.0',
  model: 'gpt-4.1-mini',
  baseURL: '',
  apiKey: '',
  apiMode: 'chat_completions',
  temperature: 0.7,
  temperatureEnabled: false,
  maxTokens: undefined,
  reasoningEffort: 'medium',
  reasoningEffortEnabled: false,
  fakeMode: false,
  autoModel: true,
  markdownPreview: true,
  streamMode: true,
  includeChatHistory: true,
  sendImagesOnlyOnce: true,
  imageGenerationMode: false,
  imageGenerationModel: '',
  imageGenerationBaseURL: '',
  imageGenerationApiKey: '',
  sidebarOpen: true,
  templateModels: {},
}

function Harness() {
  const [currentSettings, setCurrentSettings] = useState(settings)

  return <ChatSettings settings={currentSettings} showActions={true} onChange={setCurrentSettings} />
}

describe('ChatSettings の autoModel', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createLocalStorageMock({ [STORAGE_KEY]: JSON.stringify(settings) }))
    useModelFetchingMock.mockReturnValue({
      fetchedModels: ['gemini-2.5-flash'],
      isLoadingModels: false,
      fetchError: null,
      refetchModels: vi.fn(),
    })
    useImageGenerationModelMock.mockReturnValue({
      imageModels: [],
      isLoadingImageModels: false,
      imageModelsError: null,
      refetchImageModels: vi.fn(),
      imageGenerationConnection: { baseURL: '', apiKey: '' },
      resolvedImageGenerationModel: null,
    })
  })

  it('取得したモデルが1件だけのときは右上のラベルと localStorage にそのモデルを反映する', async () => {
    render(<Harness />)

    await waitFor(() => {
      expect(screen.getByText('gemini-2.5-flash', { selector: 'span' })).toBeTruthy()
    })

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({ model: 'gemini-2.5-flash' })
  })
})
