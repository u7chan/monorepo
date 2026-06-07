import { z } from 'zod'

export const SubtitleStyleSchema = z.object({
  fontFamilyId: z.string().default('default'),
  fontSize: z.number().int().min(1).default(48),
  fontColor: z.string().default('#FFFFFF'),
  bold: z.boolean().default(false),
  italic: z.boolean().default(false),
  outlineColor: z.string().default('#000000'),
  outlineWidth: z.number().min(0).default(2),
  shadow: z
    .object({
      enabled: z.boolean().default(false),
      color: z.string().default('#000000'),
      offsetX: z.number().default(0),
      offsetY: z.number().default(0),
      blur: z.number().min(0).default(0),
    })
    .optional(),
  backgroundBox: z
    .object({
      enabled: z.boolean().default(false),
      color: z.string().default('#000000'),
      opacity: z.number().min(0).max(1).default(0.6),
      padding: z.number().min(0).default(4),
    })
    .optional(),
  position: z.enum(['top', 'center', 'bottom']).default('bottom'),
  margin: z
    .object({
      x: z.number().default(0),
      y: z.number().default(0),
    })
    .optional(),
})

export type SubtitleStyle = z.infer<typeof SubtitleStyleSchema>
