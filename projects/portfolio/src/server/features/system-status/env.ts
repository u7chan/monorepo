import type { Env } from '#/server/routes/shared'

export type SystemStatusEnv = Pick<
  Env,
  | 'DATABASE_URL'
  | 'FILE_SERVER_URL'
  | 'FILE_SERVER_PUBLIC_URL'
  | 'FILE_SERVER_ADMIN_USERNAME'
  | 'FILE_SERVER_ADMIN_PASSWORD'
>
