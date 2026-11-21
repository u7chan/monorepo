import { sValidator } from '@hono/standard-validator'
import type { z } from 'zod'
import { validationError } from './chat-error'

const formatValidationPath = (path: unknown): string => {
  if (!Array.isArray(path) || path.length === 0) return 'request body'

  const keys = path
    .map((segment) => {
      if (typeof segment === 'string' || typeof segment === 'number') return String(segment)
      if (segment && typeof segment === 'object' && 'key' in segment) return String(segment.key)
      return null
    })
    .filter((segment): segment is string => Boolean(segment))

  return keys.join('.') || 'request body'
}

/**
 * JSON ボディの検証結果を、この API の公開エラー形式 `Invalid request body '<field>'` に落とす。
 * `sValidator` の既定応答は内部形式なので、クライアントが message を表示できる形を崩さないために包む。
 */
export const jsonBodyValidator = <T extends z.ZodType>(schema: T) =>
  sValidator('json', schema, (result, c) => {
    if (result.success) return

    const issue = result.error[0]
    return c.json(validationError(`Invalid request body '${formatValidationPath(issue?.path)}'`), 400)
  })
