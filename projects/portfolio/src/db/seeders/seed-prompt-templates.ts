import { upsertPromptTemplates } from './upsert-prompt-templates'

async function main() {
  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required')
  }

  const count = await upsertPromptTemplates({ databaseUrl })
  console.log(`Upserted ${count} prompt templates`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
