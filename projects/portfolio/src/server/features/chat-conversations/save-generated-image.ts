import {
  buildFileServerPreviewUrl,
  loginToFileServer,
  type FileServerConfig,
  uploadFileToFileServer,
} from '#/server/features/chat-conversations/file-server-client'
import { logger } from '#/server/lib/logger'
import type { GeneratedImage } from '#/types'

export type SaveGeneratedImageResult =
  | { ok: true; image: GeneratedImage }
  | { ok: false; reason: 'file-server-unavailable' | 'upload-failed' }

interface SaveGeneratedImageParams {
  conversationId: string
  assistantMessageId: string
  content: ArrayBuffer
  contentType: 'image/png'
  createdAt: string
}

export async function saveGeneratedImage(
  params: SaveGeneratedImageParams,
  fileServerConfig: FileServerConfig | null
): Promise<SaveGeneratedImageResult> {
  if (!fileServerConfig) {
    return { ok: false, reason: 'file-server-unavailable' }
  }

  const fileName = `${params.assistantMessageId}-image-0.png`
  const publicPath = `/public/portfolio/${params.conversationId}/${fileName}`
  const virtualPath = publicPath.slice(1)

  try {
    const session = await loginToFileServer(fileServerConfig)
    await uploadFileToFileServer(fileServerConfig, session, {
      fileName,
      content: params.content,
      contentType: params.contentType,
      path: virtualPath,
    })
  } catch (error) {
    logger.error({ err: error }, 'failed to upload generated image to file-server')
    return { ok: false, reason: 'upload-failed' }
  }

  return {
    ok: true,
    image: {
      fileName,
      publicPath,
      previewUrl: buildFileServerPreviewUrl(fileServerConfig.publicBaseUrl, publicPath),
      contentType: params.contentType,
      createdAt: params.createdAt,
    },
  }
}
