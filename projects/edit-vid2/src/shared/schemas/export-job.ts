import { z } from 'zod'

export const ExportJobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'canceling', 'canceled'])

export const ExportPresetSchema = z.object({
  format: z.enum(['mp4']).default('mp4'),
  videoCodec: z.enum(['libx264', 'libx265']).default('libx264'),
  audioCodec: z.enum(['aac', 'copy']).default('aac'),
  crf: z.number().int().min(0).max(51).default(23),
  preset: z.enum(['ultrafast', 'fast', 'medium', 'slow']).default('medium'),
})

export const ExportJobSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  status: ExportJobStatusSchema,
  progress: z.number().min(0).max(100).default(0),
  snapshot: z.unknown().nullable(),
  preset: ExportPresetSchema.nullable(),
  outputPath: z.string().nullable(),
  logPath: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
})

export const CreateExportJobSchema = z.object({
  preset: ExportPresetSchema.optional(),
})

export type ExportJobStatus = z.infer<typeof ExportJobStatusSchema>
export type ExportPreset = z.infer<typeof ExportPresetSchema>
export type ExportJob = z.infer<typeof ExportJobSchema>
export type CreateExportJob = z.infer<typeof CreateExportJobSchema>
