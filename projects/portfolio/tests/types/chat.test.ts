import { AssistantMetadataSchema, ConversationListResponseSchema, GeneratedCodeFileSchema } from '#/types'
import { describe, expect, it } from 'vitest'

describe('chat types', () => {
  it('updatedAt を含む会話一覧レスポンスを正規化できる', () => {
    const response = ConversationListResponseSchema.parse({
      data: [
        {
          id: 'conversation-1',
          title: 'Legacy conversation',
          updatedAt: '2026-04-14T12:34:56.000Z',
          messages: [
            {
              id: 'message-1',
              role: 'user',
              content: 'hello',
              reasoningContent: '',
              metadata: {},
            },
            {
              id: 'message-2',
              role: 'assistant',
              content: 'world',
              reasoningContent: '',
              metadata: {},
            },
          ],
        },
      ],
    })

    expect(response).toEqual({
      data: [
        {
          id: 'conversation-1',
          title: 'Legacy conversation',
          updatedAt: new Date('2026-04-14T12:34:56.000Z'),
          messages: [
            {
              id: 'message-1',
              role: 'user',
              content: 'hello',
              reasoningContent: '',
              metadata: {
                model: '',
              },
            },
            {
              id: 'message-2',
              role: 'assistant',
              content: 'world',
              reasoningContent: '',
              metadata: {
                model: '',
                usage: {},
              },
            },
          ],
        },
      ],
    })
  })

  describe('AssistantMetadataSchema', () => {
    it('apiMode を含む metadata も parse できる', () => {
      const parsed = AssistantMetadataSchema.parse({
        model: 'gpt',
        apiMode: 'responses',
        usage: {},
      })

      expect(parsed.apiMode).toBe('responses')
    })

    it('generatedFiles を parse できる', () => {
      const parsed = AssistantMetadataSchema.parse({
        model: 'gpt',
        usage: {},
        generatedFiles: [
          {
            blockIndex: 0,
            language: 'html',
            fileName: 'msg-1-block-0.html',
            publicPath: '/public/portfolio/conv-1/msg-1-block-0.html',
            previewUrl: 'http://localhost:3001/public/portfolio/conv-1/msg-1-block-0.html',
            contentType: 'text/html; charset=utf-8',
            createdAt: '2026-04-19T00:00:00.000Z',
          },
        ],
      })

      expect(parsed.generatedFiles).toHaveLength(1)
      expect(parsed.generatedFiles?.[0].blockIndex).toBe(0)
    })

    it('generatedFiles 未指定の metadata も parse できる', () => {
      const parsed = AssistantMetadataSchema.parse({ model: 'gpt', usage: {} })
      expect(parsed.generatedFiles).toBeUndefined()
    })
  })

  describe('GeneratedCodeFileSchema', () => {
    it('必須フィールドが揃っていれば parse できる', () => {
      expect(() =>
        GeneratedCodeFileSchema.parse({
          blockIndex: 2,
          language: 'svg',
          fileName: 'msg-1-block-2.svg',
          publicPath: '/public/portfolio/conv/msg-1-block-2.svg',
          previewUrl: 'http://fs/public/portfolio/conv/msg-1-block-2.svg',
          contentType: 'image/svg+xml; charset=utf-8',
          createdAt: '2026-04-19T00:00:00.000Z',
        })
      ).not.toThrow()
    })

    it('blockIndex が負の値なら reject する', () => {
      expect(() =>
        GeneratedCodeFileSchema.parse({
          blockIndex: -1,
          language: 'svg',
          fileName: 'f.svg',
          publicPath: '/public/f.svg',
          previewUrl: 'http://f/f.svg',
          contentType: 'image/svg+xml',
          createdAt: '2026-04-19T00:00:00.000Z',
        })
      ).toThrow()
    })
  })

  it('updatedAt が無い既存レスポンスも正規化できる', () => {
    const response = ConversationListResponseSchema.parse({
      data: [
        {
          id: 'conversation-1',
          title: 'Legacy conversation',
          messages: [],
        },
      ],
    })

    expect(response).toEqual({
      data: [
        {
          id: 'conversation-1',
          title: 'Legacy conversation',
          messages: [],
        },
      ],
    })
  })
})
