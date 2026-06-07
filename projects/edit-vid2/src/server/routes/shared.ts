import type { AppDatabase } from '#/db'

export type Env = Partial<{
  NODE_ENV: string
  SERVER_PORT: string
  DATABASE_URL: string
  MAX_UPLOAD_BYTES: string
  LOG_LEVEL: string
}>

export type HonoEnv = {
  Bindings: Env
  Variables: {
    db: AppDatabase
  }
}
