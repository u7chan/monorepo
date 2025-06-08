import { defineConfig } from 'drizzle-kit'

const url = process.env.DATABASE_URL || ''

console.log('DATABASE_URL:', url)

export default defineConfig({
  out: './drizzle',
  schema: './src/server/db/schema.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url,
  },
})
