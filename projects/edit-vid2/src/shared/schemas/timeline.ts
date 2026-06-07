import { z } from 'zod'
import { SubtitleStyleSchema } from './subtitle-style'

export const SubtitleItemSchema = z.object({
  id: z.string(),
  sourceStart: z.number().min(0),
  sourceEnd: z.number().min(0),
  text: z.string(),
  templateId: z.string(),
  styleOverrides: SubtitleStyleSchema.partial().default({}),
})

export const KeepSegmentSchema = z.object({
  id: z.string(),
  sourceStart: z.number().min(0),
  sourceEnd: z.number().min(0),
})

export const TimelineTrackSchema = z.object({
  id: z.string(),
  type: z.literal('subtitle'),
  items: z.array(SubtitleItemSchema).default([]),
})

export const TimelineStateV1Schema = z.object({
  version: z.literal(1),
  tracks: z.array(TimelineTrackSchema).default([]),
  keepSegments: z.array(KeepSegmentSchema).default([]),
})

export const MappedSubtitleSchema = z.object({
  text: z.string(),
  outputStart: z.number(),
  outputEnd: z.number(),
  templateId: z.string(),
  styleOverrides: SubtitleStyleSchema.partial().default({}),
})

export type SubtitleItem = z.infer<typeof SubtitleItemSchema>
export type KeepSegment = z.infer<typeof KeepSegmentSchema>
export type TimelineTrack = z.infer<typeof TimelineTrackSchema>
export type TimelineStateV1 = z.infer<typeof TimelineStateV1Schema>
export type MappedSubtitle = z.infer<typeof MappedSubtitleSchema>
