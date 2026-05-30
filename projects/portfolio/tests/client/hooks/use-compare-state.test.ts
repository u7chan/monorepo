// @vitest-environment jsdom

import { renderHook, act } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useCompareState } from '#/client/features/chat-compare/hooks/use-compare-state'

describe('useCompareState', () => {
  describe('setModelCancelled', () => {
    it('は部分出力を保持したまま status を cancelled に変更する', () => {
      const { result } = renderHook(() => useCompareState())

      act(() => {
        result.current.setSelectedModels(['model-a'])
        result.current.initModelStates(['model-a'])
      })

      const model = 'model-a'
      act(() => {
        result.current.updateStreamingContent(model, 'partial content', 'partial reasoning')
      })
      act(() => {
        result.current.setModelCancelled(model)
      })

      const state = result.current.modelStates[model]
      expect(state.status).toBe('cancelled')
      expect(state.content).toBe('partial content')
      expect(state.reasoningContent).toBe('partial reasoning')
      expect(state.error).toBe('Cancelled by user')
    })
  })

  describe('setModelRetrying', () => {
    it('は streaming 関連データをクリアし status を retrying に変更する', () => {
      const { result } = renderHook(() => useCompareState())

      act(() => {
        result.current.setSelectedModels(['model-a'])
        result.current.initModelStates(['model-a'])
      })

      const model = 'model-a'
      act(() => {
        result.current.updateStreamingContent(model, 'partial', 'reasoning')
      })
      act(() => {
        result.current.setModelError(model, 'some error')
      })
      act(() => {
        result.current.setModelRetrying(model)
      })

      const state = result.current.modelStates[model]
      expect(state.status).toBe('retrying')
      expect(state.content).toBe('')
      expect(state.reasoningContent).toBe('')
      expect(state.usage).toBeNull()
      expect(state.finishReason).toBeNull()
      expect(state.responseTimeMs).toBeNull()
      expect(state.error).toBeNull()
    })
  })

  describe('setModelError', () => {
    it('は部分出力を保持したまま status を error に変更する', () => {
      const { result } = renderHook(() => useCompareState())

      act(() => {
        result.current.setSelectedModels(['model-a'])
        result.current.initModelStates(['model-a'])
      })

      const model = 'model-a'
      act(() => {
        result.current.updateStreamingContent(model, 'partial content', '')
      })
      act(() => {
        result.current.setModelError(model, 'Network error')
      })

      const state = result.current.modelStates[model]
      expect(state.status).toBe('error')
      expect(state.content).toBe('partial content')
      expect(state.error).toBe('Network error')
    })
  })

  describe('isSubmitting', () => {
    it('は streaming または retrying のモデルが1つでもあれば true になる', () => {
      const { result } = renderHook(() => useCompareState())

      act(() => {
        result.current.setSelectedModels(['model-a', 'model-b'])
        result.current.initModelStates(['model-a', 'model-b'])
      })

      expect(result.current.isSubmitting).toBe(false)

      act(() => {
        result.current.setModelStreaming('model-a')
      })

      expect(result.current.isSubmitting).toBe(true)

      act(() => {
        result.current.setModelDone('model-a', {
          finishReason: 'stop',
          usage: null,
          responseTimeMs: 100,
        })
      })

      expect(result.current.isSubmitting).toBe(false)

      act(() => {
        result.current.setModelRetrying('model-b')
      })

      expect(result.current.isSubmitting).toBe(true)
    })

    it('は全モデルが idle/done/error/cancelled の場合は false になる', () => {
      const { result } = renderHook(() => useCompareState())

      act(() => {
        result.current.setSelectedModels(['model-a', 'model-b'])
        result.current.initModelStates(['model-a', 'model-b'])
      })

      expect(result.current.isSubmitting).toBe(false)

      act(() => {
        result.current.setModelDone('model-a', {
          finishReason: 'stop',
          usage: null,
          responseTimeMs: 100,
        })
      })
      act(() => {
        result.current.setModelError('model-b', 'error')
      })

      expect(result.current.isSubmitting).toBe(false)

      act(() => {
        result.current.setModelCancelled('model-a')
      })

      expect(result.current.isSubmitting).toBe(false)
    })
  })

  describe('appendAssistantMessage', () => {
    it('は streaming データをキープしたまま assistant メッセージを messages に追加する', () => {
      const { result } = renderHook(() => useCompareState())

      act(() => {
        result.current.setSelectedModels(['model-a'])
        result.current.initModelStates(['model-a'])
      })

      const userMessage = { role: 'user' as const, content: 'hello' }
      act(() => {
        result.current.appendUserMessageToAll(['model-a'], userMessage)
      })

      const assistantMessage = { role: 'assistant' as const, content: 'hi there' }
      act(() => {
        result.current.appendAssistantMessage('model-a', assistantMessage)
      })

      const state = result.current.modelStates['model-a']
      expect(state.messages).toHaveLength(2)
      expect(state.messages[0]).toEqual(userMessage)
      expect(state.messages[1]).toHaveProperty('role', 'assistant')
      expect(state.messages[1]).toHaveProperty('content', 'hi there')
    })
  })

  describe('resetModelStream', () => {
    it('は全データをクリアし status を idle に戻す', () => {
      const { result } = renderHook(() => useCompareState())

      act(() => {
        result.current.setSelectedModels(['model-a'])
        result.current.initModelStates(['model-a'])
      })

      act(() => {
        result.current.updateStreamingContent('model-a', 'content', 'reasoning')
      })
      act(() => {
        result.current.resetModelStream('model-a')
      })

      const state = result.current.modelStates['model-a']
      expect(state.status).toBe('idle')
      expect(state.content).toBe('')
      expect(state.reasoningContent).toBe('')
      expect(state.messages).toHaveLength(0)
    })
  })
})
