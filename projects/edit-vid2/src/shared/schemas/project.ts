import { z } from 'zod'
import { TimelineStateV1Schema } from './timeline'

export const ProjectSchema = z.object({
  id: z.string(),
  videoAssetId: z.string(),
  name: z.string(),
  timelineState: TimelineStateV1Schema.nullable(),
  timelineStateVersion: z.number().int().default(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
})

export const CreateProjectSchema = z.object({
  name: z.string().min(1).max(255),
  videoAssetId: z.string(),
})

export const UpdateProjectSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  videoAssetId: z.string().optional(),
  timelineState: TimelineStateV1Schema.optional(),
})

export const DuplicateProjectSchema = z.object({
  name: z.string().min(1).max(255).optional(),
})

export type Project = z.infer<typeof ProjectSchema>
export type CreateProject = z.infer<typeof CreateProjectSchema>
export type UpdateProject = z.infer<typeof UpdateProjectSchema>
export type DuplicateProject = z.infer<typeof DuplicateProjectSchema>
