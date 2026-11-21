import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { HonoEnv } from '#/server/routes/shared'
import type { ChatSessionEvent } from '#/types/chat-api'
import { chatSessionManager, isTerminalSessionEvent } from './session-manager'

type SseStream = Parameters<Parameters<typeof streamSSE>[1]>[0]

export interface StreamSessionEventsOptions {
  afterEventId?: string
  disconnectGraceMs: number
}

const writeSessionEvent = (stream: SseStream, event: ChatSessionEvent): Promise<void> =>
  stream.writeSSE({
    id: event.id,
    event: event.type,
    data: JSON.stringify(event),
  })

/**
 * セッションのイベントを、replay → 購読 → replay の順で SSE に流す。
 * 購読を張る前のイベントを取りこぼさないため、購読開始後にもう一度 replay する。
 */
export const streamSessionEvents = (
  c: Context<HonoEnv>,
  sessionId: string,
  { afterEventId, disconnectGraceMs }: StreamSessionEventsOptions
) =>
  streamSSE(c, async (stream) => {
    let closed = false
    let unsubscribe: (() => void) | null = null

    const close = () => {
      if (closed) return
      closed = true
      unsubscribe?.()
      chatSessionManager.scheduleDisconnectGrace(sessionId, disconnectGraceMs)
    }

    stream.onAbort(close)

    let lastEventId = afterEventId
    const replayEvents = async () => {
      for (const event of await chatSessionManager.readEvents(sessionId, lastEventId)) {
        await writeSessionEvent(stream, event)
        lastEventId = event.id
        if (isTerminalSessionEvent(event)) {
          close()
          return true
        }
      }
      return false
    }

    if (await replayEvents()) return

    if ((await chatSessionManager.getSession(sessionId))?.status !== 'running') {
      if (await replayEvents()) return
      close()
      return
    }

    await new Promise<void>((resolve, reject) => {
      void chatSessionManager
        .subscribe(sessionId, (event) => {
          void writeSessionEvent(stream, event).then(() => {
            lastEventId = event.id
            if (isTerminalSessionEvent(event)) {
              close()
              resolve()
            }
          })
        })
        .then((nextUnsubscribe) => {
          unsubscribe = nextUnsubscribe
          void replayEvents().then((isTerminal) => {
            if (isTerminal) {
              resolve()
            }
          }, reject)
        })
        .catch(reject)
    })

    close()
  })
