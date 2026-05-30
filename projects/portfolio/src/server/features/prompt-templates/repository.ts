import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDatabase } from '#/db'
import { promptTemplatesTable } from '#/db/schema'

export const PromptTemplateSchema = z.object({
  id: z.string(),
  inputType: z.enum(['text', 'textarea']),
  title: z.string(),
  placeholder: z.string(),
  prompt: z.string(),
})

export type PromptTemplate = z.infer<typeof PromptTemplateSchema>

export async function readPromptTemplates(databaseUrl: string): Promise<PromptTemplate[]> {
  const db = getDatabase(databaseUrl)
  const rows = await db
    .select({
      id: promptTemplatesTable.id,
      inputType: promptTemplatesTable.inputType,
      title: promptTemplatesTable.title,
      placeholder: promptTemplatesTable.placeholder,
      prompt: promptTemplatesTable.prompt,
    })
    .from(promptTemplatesTable)
    .where(eq(promptTemplatesTable.enabled, true))
    .orderBy(asc(promptTemplatesTable.displayOrder), asc(promptTemplatesTable.id))

  return rows.map((row) => PromptTemplateSchema.parse(row))
}

export const promptTemplateRepository = {
  read: readPromptTemplates,
}
