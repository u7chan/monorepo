import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockLogger } from '../../helpers/mock-logger'

const importSubject = async (params: {
  users: Array<{ id: string; email: string }>
  ownedRow?: {
    messageId: string
    role: string
    metadata: unknown
    conversationUserId: string
  }
  fileExists?: boolean
}) => {
  mockLogger()
  const updateSets: unknown[] = []
  let selectCall = 0

  const db = {
    select: vi.fn(() => {
      selectCall += 1
      if (selectCall === 1) {
        return {
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue(params.users),
          })),
        }
      }
      return {
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn().mockResolvedValue(params.ownedRow ? [params.ownedRow] : []),
          })),
        })),
      }
    }),
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => {
        updateSets.push(values)
        return { where: vi.fn().mockResolvedValue(undefined) }
      }),
    })),
  }

  vi.doMock('#/db', () => ({
    getDatabase: vi.fn(() => db),
  }))

  const loginToFileServer = vi.fn().mockResolvedValue('session-value')
  const uploadFileToFileServer = vi.fn().mockResolvedValue(undefined)
  const checkFileExists = vi.fn().mockResolvedValue(params.fileExists ?? true)
  vi.doMock('#/server/features/chat-conversations/file-server-client', () => ({
    buildFileServerPreviewUrl: vi.fn((publicBaseUrl: string, publicPath: string) => `${publicBaseUrl}${publicPath}`),
    checkFileExists,
    loginToFileServer,
    uploadFileToFileServer,
  }))

  const { saveGeneratedFile, resolveExtension } =
    await import('#/server/features/chat-conversations/save-generated-file')
  return { saveGeneratedFile, resolveExtension, updateSets, checkFileExists, loginToFileServer, uploadFileToFileServer }
}

describe('saveGeneratedFile', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('file-server config が null なら file-server-unavailable を返す', async () => {
    const { saveGeneratedFile, loginToFileServer } = await importSubject({
      users: [{ id: 'u1', email: 'x@example.com' }],
    })

    const result = await saveGeneratedFile(
      'postgres://db',
      'x@example.com',
      {
        conversationId: 'c1',
        messageId: 'm1',
        blockIndex: 0,
        language: 'html',
        content: '<p>hello</p>',
      },
      null
    )

    expect(result).toEqual({ ok: false, reason: 'file-server-unavailable' })
    expect(loginToFileServer).not.toHaveBeenCalled()
  })

  it('未対応の language は invalid-role を返す', async () => {
    const { saveGeneratedFile } = await importSubject({
      users: [{ id: 'u1', email: 'x@example.com' }],
    })

    const result = await saveGeneratedFile(
      'postgres://db',
      'x@example.com',
      {
        conversationId: 'c1',
        messageId: 'm1',
        blockIndex: 0,
        language: 'python',
        content: 'print(1)',
      },
      {
        baseUrl: 'http://fs',
        publicBaseUrl: 'http://files.example.com',
        credentials: { username: 'admin', password: 'p' },
      }
    )

    expect(result.ok).toBe(false)
  })

  it('他ユーザーの conversation には forbidden を返す', async () => {
    const { saveGeneratedFile } = await importSubject({
      users: [{ id: 'u1', email: 'x@example.com' }],
      ownedRow: { messageId: 'm1', role: 'assistant', metadata: {}, conversationUserId: 'other' },
    })

    const result = await saveGeneratedFile(
      'postgres://db',
      'x@example.com',
      {
        conversationId: 'c1',
        messageId: 'm1',
        blockIndex: 0,
        language: 'html',
        content: '<p/>',
      },
      {
        baseUrl: 'http://fs',
        publicBaseUrl: 'http://files.example.com',
        credentials: { username: 'admin', password: 'p' },
      }
    )

    expect(result).toEqual({ ok: false, reason: 'forbidden' })
  })

  it('初回保存時のみ upload 実行し、再実行時は既存 file を返す', async () => {
    const existing = {
      blockIndex: 0,
      language: 'html',
      fileName: 'm1-block-0.html',
      publicPath: '/public/portfolio/c1/m1-block-0.html',
      previewUrl: 'http://files.example.com/public/portfolio/c1/m1-block-0.html',
      contentType: 'text/html; charset=utf-8',
      createdAt: '2026-04-19T00:00:00.000Z',
    }

    // 再実行ケース
    const { saveGeneratedFile, uploadFileToFileServer } = await importSubject({
      users: [{ id: 'u1', email: 'x@example.com' }],
      ownedRow: {
        messageId: 'm1',
        role: 'assistant',
        metadata: { generatedFiles: [existing] },
        conversationUserId: 'u1',
      },
    })

    const result = await saveGeneratedFile(
      'postgres://db',
      'x@example.com',
      { conversationId: 'c1', messageId: 'm1', blockIndex: 0, language: 'html', content: '<p/>' },
      {
        baseUrl: 'http://fs',
        publicBaseUrl: 'http://files.example.com',
        credentials: { username: 'admin', password: 'p' },
      }
    )

    expect(result).toEqual({ ok: true, file: existing, alreadyExisted: true })
    expect(uploadFileToFileServer).not.toHaveBeenCalled()
  })

  it('force 指定でも既存ファイルが存在すれば upload しない', async () => {
    const existing = {
      blockIndex: 0,
      language: 'html',
      fileName: 'm1-block-0.html',
      publicPath: '/public/portfolio/c1/m1-block-0.html',
      previewUrl: 'http://files.example.com/public/portfolio/c1/m1-block-0.html',
      contentType: 'text/html; charset=utf-8',
      createdAt: '2026-04-19T00:00:00.000Z',
    }
    const { saveGeneratedFile, checkFileExists, uploadFileToFileServer } = await importSubject({
      users: [{ id: 'u1', email: 'x@example.com' }],
      ownedRow: {
        messageId: 'm1',
        role: 'assistant',
        metadata: { generatedFiles: [existing] },
        conversationUserId: 'u1',
      },
      fileExists: true,
    })

    const result = await saveGeneratedFile(
      'postgres://db',
      'x@example.com',
      { conversationId: 'c1', messageId: 'm1', blockIndex: 0, language: 'html', content: '<p/>', force: true },
      {
        baseUrl: 'http://fs',
        publicBaseUrl: 'http://files.example.com',
        credentials: { username: 'admin', password: 'p' },
      }
    )

    expect(result).toEqual({ ok: true, file: existing, alreadyExisted: true })
    expect(checkFileExists).toHaveBeenCalledWith('http://files.example.com', existing.publicPath)
    expect(uploadFileToFileServer).not.toHaveBeenCalled()
  })

  it('force 指定で既存ファイルが不在なら再 upload して同一 blockIndex を置換する', async () => {
    const existing = {
      blockIndex: 0,
      language: 'html',
      fileName: 'm1-block-0.html',
      publicPath: '/public/portfolio/c1/m1-block-0.html',
      previewUrl: 'http://files.example.com/public/portfolio/c1/m1-block-0.html',
      contentType: 'text/html; charset=utf-8',
      createdAt: '2026-04-19T00:00:00.000Z',
    }
    const other = {
      blockIndex: 1,
      language: 'svg',
      fileName: 'm1-block-1.svg',
      publicPath: '/public/portfolio/c1/m1-block-1.svg',
      previewUrl: 'http://files.example.com/public/portfolio/c1/m1-block-1.svg',
      contentType: 'image/svg+xml; charset=utf-8',
      createdAt: '2026-04-19T00:00:00.000Z',
    }
    const { saveGeneratedFile, updateSets, uploadFileToFileServer } = await importSubject({
      users: [{ id: 'u1', email: 'x@example.com' }],
      ownedRow: {
        messageId: 'm1',
        role: 'assistant',
        metadata: { generatedFiles: [existing, other] },
        conversationUserId: 'u1',
      },
      fileExists: false,
    })

    const result = await saveGeneratedFile(
      'postgres://db',
      'x@example.com',
      { conversationId: 'c1', messageId: 'm1', blockIndex: 0, language: 'html', content: '<p>new</p>', force: true },
      {
        baseUrl: 'http://fs',
        publicBaseUrl: 'http://files.example.com',
        credentials: { username: 'admin', password: 'p' },
      }
    )

    expect(result).toMatchObject({ ok: true, alreadyExisted: false })
    expect(uploadFileToFileServer).toHaveBeenCalledWith(
      expect.anything(),
      'session-value',
      expect.objectContaining({ fileName: 'm1-block-0.html', content: '<p>new</p>' })
    )
    expect(updateSets[0]).toMatchObject({
      metadata: {
        generatedFiles: [
          other,
          expect.objectContaining({
            blockIndex: 0,
            publicPath: '/public/portfolio/c1/m1-block-0.html',
          }),
        ],
      },
    })
  })

  it('新規保存時は login+upload して metadata.generatedFiles を更新する', async () => {
    const { saveGeneratedFile, updateSets, loginToFileServer, uploadFileToFileServer } = await importSubject({
      users: [{ id: 'u1', email: 'x@example.com' }],
      ownedRow: {
        messageId: 'm1',
        role: 'assistant',
        metadata: { model: 'gpt' },
        conversationUserId: 'u1',
      },
    })

    const result = await saveGeneratedFile(
      'postgres://db',
      'x@example.com',
      { conversationId: 'c1', messageId: 'm1', blockIndex: 2, language: 'svg', content: '<svg/>' },
      {
        baseUrl: 'http://fs',
        publicBaseUrl: 'http://files.example.com',
        credentials: { username: 'admin', password: 'p' },
      }
    )

    expect(result.ok).toBe(true)
    expect(loginToFileServer).toHaveBeenCalled()
    expect(uploadFileToFileServer).toHaveBeenCalledWith(
      expect.anything(),
      'session-value',
      expect.objectContaining({
        fileName: 'm1-block-2.svg',
        contentType: 'image/svg+xml; charset=utf-8',
        path: 'public/portfolio/c1/m1-block-2.svg',
      })
    )
    expect(updateSets[0]).toMatchObject({
      metadata: {
        model: 'gpt',
        generatedFiles: [
          expect.objectContaining({
            blockIndex: 2,
            publicPath: '/public/portfolio/c1/m1-block-2.svg',
            previewUrl: 'http://files.example.com/public/portfolio/c1/m1-block-2.svg',
          }),
        ],
      },
    })
  })
})
