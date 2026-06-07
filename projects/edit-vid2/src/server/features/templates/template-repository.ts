import { and, eq, isNull } from 'drizzle-orm'
import type { AppDatabase } from '#/db'
import { subtitleTemplates } from '#/db/schema'

export function getTemplates(db: AppDatabase) {
  return db.select().from(subtitleTemplates).where(isNull(subtitleTemplates.deletedAt)).all()
}

export function getTemplateById(db: AppDatabase, id: string) {
  return db
    .select()
    .from(subtitleTemplates)
    .where(and(eq(subtitleTemplates.id, id), isNull(subtitleTemplates.deletedAt)))
    .get()
}

export function createTemplate(
  db: AppDatabase,
  data: {
    id: string
    name: string
    fontFamilyId?: string
    fontSize?: number
    fontColor?: string
    bold?: boolean
    italic?: boolean
    outlineColor?: string
    outlineWidth?: number
    shadowEnabled?: boolean
    shadowColor?: string
    shadowOffsetX?: number
    shadowOffsetY?: number
    shadowBlur?: number
    backgroundBoxEnabled?: boolean
    backgroundBoxColor?: string
    backgroundBoxOpacity?: number
    backgroundBoxPadding?: number
    position?: string
    marginX?: number
    marginY?: number
  }
) {
  db.insert(subtitleTemplates)
    .values({
      id: data.id,
      name: data.name,
      fontFamilyId: data.fontFamilyId ?? 'default',
      fontSize: data.fontSize ?? 48,
      fontColor: data.fontColor ?? '#FFFFFF',
      bold: data.bold ?? false,
      italic: data.italic ?? false,
      outlineColor: data.outlineColor ?? '#000000',
      outlineWidth: data.outlineWidth ?? 2,
      shadowEnabled: data.shadowEnabled ?? false,
      shadowColor: data.shadowColor ?? '#000000',
      shadowOffsetX: data.shadowOffsetX ?? 0,
      shadowOffsetY: data.shadowOffsetY ?? 0,
      shadowBlur: data.shadowBlur ?? 0,
      backgroundBoxEnabled: data.backgroundBoxEnabled ?? false,
      backgroundBoxColor: data.backgroundBoxColor ?? '#000000',
      backgroundBoxOpacity: data.backgroundBoxOpacity ?? 0.6,
      backgroundBoxPadding: data.backgroundBoxPadding ?? 4,
      position: data.position ?? 'bottom',
      marginX: data.marginX ?? 0,
      marginY: data.marginY ?? 0,
    })
    .run()
  return getTemplateById(db, data.id)!
}

export function updateTemplate(db: AppDatabase, id: string, data: Record<string, unknown>) {
  db.update(subtitleTemplates)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(subtitleTemplates.id, id))
    .run()
  return getTemplateById(db, id)
}

export function softDeleteTemplate(db: AppDatabase, id: string) {
  db.update(subtitleTemplates)
    .set({ deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(eq(subtitleTemplates.id, id))
    .run()
}
