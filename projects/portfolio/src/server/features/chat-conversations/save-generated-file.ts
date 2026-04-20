import { getDatabase } from '#/db'
import { conversationsTable, messagesTable, usersTable } from '#/db/schema'
import {
  type FileServerConfig,
  loginToFileServer,
  uploadFileToFileServer,
} from '#/server/features/chat-conversations/file-server-client'
import { logger } from '#/server/lib/logger'
import type { AssistantMetadata, GeneratedCodeFile } from '#/types'
import { and, eq } from 'drizzle-orm'

export type SaveGeneratedFileResult =
  | { ok: true; file: GeneratedCodeFile; alreadyExisted: boolean }
  | {
      ok: false
      reason:
        | 'user-not-found'
        | 'message-not-found'
        | 'forbidden'
        | 'invalid-role'
        | 'file-server-unavailable'
        | 'upload-failed'
    }

interface SaveGeneratedFileParams {
  conversationId: string
  messageId: string
  blockIndex: number
  language: string
  content: string
}

const LANGUAGE_EXTENSION_MAP: Record<string, { ext: string; contentType: string }> = {
  html: { ext: 'html', contentType: 'text/html; charset=utf-8' },
  htm: { ext: 'html', contentType: 'text/html; charset=utf-8' },
  xhtml: { ext: 'xhtml', contentType: 'application/xhtml+xml; charset=utf-8' },
  svg: { ext: 'svg', contentType: 'image/svg+xml; charset=utf-8' },
}

export function resolveExtension(language: string): { ext: string; contentType: string } | null {
  const key = language.toLowerCase()
  return LANGUAGE_EXTENSION_MAP[key] ?? null
}

function deserializeMetadata(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>
  }
  return {}
}

export async function saveGeneratedFile(
  databaseUrl: string,
  email: string,
  params: SaveGeneratedFileParams,
  fileServerConfig: FileServerConfig | null
): Promise<SaveGeneratedFileResult> {
  if (!fileServerConfig) {
    return { ok: false, reason: 'file-server-unavailable' }
  }

  const extension = resolveExtension(params.language)
  if (!extension) {
    return { ok: false, reason: 'invalid-role' }
  }

  const db = getDatabase(databaseUrl)

  const users = await db.select().from(usersTable).where(eq(usersTable.email, email))
  if (users.length <= 0) {
    logger.warn({ email }, 'No users found')
    return { ok: false, reason: 'user-not-found' }
  }
  const userId = users[0].id

  const rows = await db
    .select({
      messageId: messagesTable.id,
      role: messagesTable.role,
      metadata: messagesTable.metadata,
      conversationUserId: conversationsTable.userId,
    })
    .from(messagesTable)
    .innerJoin(conversationsTable, eq(messagesTable.conversationId, conversationsTable.id))
    .where(and(eq(messagesTable.id, params.messageId), eq(messagesTable.conversationId, params.conversationId)))

  if (rows.length === 0) {
    return { ok: false, reason: 'message-not-found' }
  }

  const row = rows[0]
  if (row.conversationUserId !== userId) {
    return { ok: false, reason: 'forbidden' }
  }
  if (row.role !== 'assistant') {
    return { ok: false, reason: 'invalid-role' }
  }

  const existingMetadata = deserializeMetadata(row.metadata)
  const existingFiles: GeneratedCodeFile[] = Array.isArray(existingMetadata.generatedFiles)
    ? (existingMetadata.generatedFiles as GeneratedCodeFile[])
    : []

  // 既に同じ blockIndex で保存済みなら再 upload せずそのまま返す
  const existing = existingFiles.find((f) => f.blockIndex === params.blockIndex)
  if (existing) {
    return { ok: true, file: existing, alreadyExisted: true }
  }

  const fileName = `${params.messageId}-block-${params.blockIndex}.${extension.ext}`
  const virtualPath = `public/portfolio/${params.conversationId}/${fileName}`
  const publicPath = `/public/portfolio/${params.conversationId}/${fileName}`

  try {
    const session = await loginToFileServer(fileServerConfig)
    await uploadFileToFileServer(fileServerConfig, session, {
      fileName,
      content: params.content,
      contentType: extension.contentType,
      path: virtualPath,
    })
  } catch (error) {
    logger.error({ err: error }, 'failed to upload generated file to file-server')
    return { ok: false, reason: 'upload-failed' }
  }

  const createdAt = new Date().toISOString()
  const previewUrl = publicPath
  const file: GeneratedCodeFile = {
    blockIndex: params.blockIndex,
    language: params.language,
    fileName,
    publicPath,
    previewUrl,
    contentType: extension.contentType,
    createdAt,
  }

  const mergedFiles = [...existingFiles, file]
  const mergedMetadata: Record<string, unknown> = {
    ...existingMetadata,
    generatedFiles: mergedFiles,
  }

  await db.update(messagesTable).set({ metadata: mergedMetadata }).where(eq(messagesTable.id, params.messageId))

  return { ok: true, file, alreadyExisted: false }
}

export type { AssistantMetadata }
