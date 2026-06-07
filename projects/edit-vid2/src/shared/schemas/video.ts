import { z } from 'zod'

export const VideoAssetStatusSchema = z.enum(['uploading', 'processing', 'ready', 'failed'])

export const VideoAssetSchema = z.object({
  id: z.string(),
  originalFilename: z.string(),
  displayName: z.string(),
  storagePath: z.string(),
  thumbnailPath: z.string().nullable(),
  duration: z.number().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  fps: z.number().nullable(),
  codec: z.string().nullable(),
  hasAudio: z.boolean().nullable(),
  fileSize: z.number().int().nullable(),
  status: VideoAssetStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
})

export const CreateVideoAssetSchema = z.object({
  displayName: z.string().optional(),
})

export const UpdateVideoAssetSchema = z.object({
  displayName: z.string().optional(),
})

export type VideoAsset = z.infer<typeof VideoAssetSchema>
export type VideoAssetStatus = z.infer<typeof VideoAssetStatusSchema>
export type CreateVideoAsset = z.infer<typeof CreateVideoAssetSchema>
export type UpdateVideoAsset = z.infer<typeof UpdateVideoAssetSchema>
