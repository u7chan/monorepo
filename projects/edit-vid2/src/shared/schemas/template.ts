import { z } from 'zod'
import { SubtitleStyleSchema } from './subtitle-style'

export const SubtitleTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  fontFamilyId: z.string().default('default'),
  fontSize: z.number().int().min(1).default(48),
  fontColor: z.string().default('#FFFFFF'),
  bold: z.boolean().default(false),
  italic: z.boolean().default(false),
  outlineColor: z.string().default('#000000'),
  outlineWidth: z.number().min(0).default(2),
  shadowEnabled: z.boolean().default(false),
  shadowColor: z.string().default('#000000'),
  shadowOffsetX: z.number().default(0),
  shadowOffsetY: z.number().default(0),
  shadowBlur: z.number().min(0).default(0),
  backgroundBoxEnabled: z.boolean().default(false),
  backgroundBoxColor: z.string().default('#000000'),
  backgroundBoxOpacity: z.number().min(0).max(1).default(0.6),
  backgroundBoxPadding: z.number().min(0).default(4),
  position: z.enum(['top', 'center', 'bottom']).default('bottom'),
  marginX: z.number().default(0),
  marginY: z.number().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
})

export const CreateSubtitleTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  fontFamilyId: z.string().optional(),
  fontSize: z.number().int().min(1).optional(),
  fontColor: z.string().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  outlineColor: z.string().optional(),
  outlineWidth: z.number().min(0).optional(),
  shadowEnabled: z.boolean().optional(),
  shadowColor: z.string().optional(),
  shadowOffsetX: z.number().optional(),
  shadowOffsetY: z.number().optional(),
  shadowBlur: z.number().min(0).optional(),
  backgroundBoxEnabled: z.boolean().optional(),
  backgroundBoxColor: z.string().optional(),
  backgroundBoxOpacity: z.number().min(0).max(1).optional(),
  backgroundBoxPadding: z.number().min(0).optional(),
  position: z.enum(['top', 'center', 'bottom']).optional(),
  marginX: z.number().optional(),
  marginY: z.number().optional(),
})

export const UpdateSubtitleTemplateSchema = CreateSubtitleTemplateSchema.partial()

export type SubtitleTemplate = z.infer<typeof SubtitleTemplateSchema>
export type CreateSubtitleTemplate = z.infer<typeof CreateSubtitleTemplateSchema>
export type UpdateSubtitleTemplate = z.infer<typeof UpdateSubtitleTemplateSchema>

export function toSubtitleStyle(template: {
  fontFamilyId: string
  fontSize: number
  fontColor: string
  bold: boolean
  italic: boolean
  outlineColor: string
  outlineWidth: number
  shadowEnabled: boolean
  shadowColor: string
  shadowOffsetX: number
  shadowOffsetY: number
  shadowBlur: number
  backgroundBoxEnabled: boolean
  backgroundBoxColor: string
  backgroundBoxOpacity: number
  backgroundBoxPadding: number
  position: string
  marginX: number
  marginY: number
}) {
  const position = (['top', 'center', 'bottom'] as const).find((p) => p === template.position) ?? 'bottom'
  return {
    fontFamilyId: template.fontFamilyId,
    fontSize: template.fontSize,
    fontColor: template.fontColor,
    bold: template.bold,
    italic: template.italic,
    outlineColor: template.outlineColor,
    outlineWidth: template.outlineWidth,
    shadow: {
      enabled: template.shadowEnabled,
      color: template.shadowColor,
      offsetX: template.shadowOffsetX,
      offsetY: template.shadowOffsetY,
      blur: template.shadowBlur,
    },
    backgroundBox: {
      enabled: template.backgroundBoxEnabled,
      color: template.backgroundBoxColor,
      opacity: template.backgroundBoxOpacity,
      padding: template.backgroundBoxPadding,
    },
    position,
    margin: {
      x: template.marginX,
      y: template.marginY,
    },
  }
}
