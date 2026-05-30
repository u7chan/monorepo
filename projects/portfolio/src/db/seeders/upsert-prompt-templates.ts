import { getDatabase } from '#/db'
import { promptTemplatesTable } from '#/db/schema'
import { defaultPromptTemplates } from './prompt-template-defaults'

export interface UpsertPromptTemplatesInput {
  databaseUrl: string
}

export async function upsertPromptTemplates({ databaseUrl }: UpsertPromptTemplatesInput) {
  const db = getDatabase(databaseUrl)
  const now = new Date()

  for (const template of defaultPromptTemplates) {
    await db
      .insert(promptTemplatesTable)
      .values({
        ...template,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: promptTemplatesTable.id,
        set: {
          inputType: template.inputType,
          title: template.title,
          placeholder: template.placeholder,
          prompt: template.prompt,
          displayOrder: template.displayOrder,
          enabled: true,
          updatedAt: now,
        },
      })
  }

  return defaultPromptTemplates.length
}
