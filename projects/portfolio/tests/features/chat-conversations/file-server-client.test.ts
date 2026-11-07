import { createServer, type RequestListener, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileServerApi } from '#/server/features/chat-conversations/file-server-client'

const servers: Server[] = []

async function startServer(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('unexpected server address')
  }

  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
  )
})

function createConfig(baseUrl: string) {
  return {
    baseUrl,
    publicBaseUrl: baseUrl,
    credentials: { username: 'admin', password: 'secret' },
  }
}

describe('readFileServerApi', () => {
  it('本文受信中の接続断は通信エラーとして伝播する', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '100',
      })
      res.write('{"files":[')
      setTimeout(() => res.socket?.destroy(), 10)
    })

    await expect(readFileServerApi(createConfig(baseUrl), 'session')).rejects.toMatchObject({
      cause: { code: 'UND_ERR_SOCKET' },
    })
  })

  it('JSON が不正な場合は invalid response エラーにする', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('not json')
    })

    await expect(readFileServerApi(createConfig(baseUrl), 'session')).rejects.toThrow(
      'file-server read returned an invalid response'
    )
  })
})
