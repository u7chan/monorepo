import { hc } from 'hono/client'
import type { InferResponseType } from 'hono/client'
import { describe, expectTypeOf, it } from 'vitest'
import type { AppType } from '#/server/app.d'
import type { SystemStatusReason } from '#/types'

const client = hc<AppType>('/')
type SystemStatusSuccessResponse = InferResponseType<(typeof client.api)['system-status']['$get'], 200>

function getDatabaseReason(body: SystemStatusSuccessResponse): SystemStatusReason {
  return body.checks.database.reason
}

describe('generated system status RPC types', () => {
  it('keeps the public reason union in the successful response', () => {
    expectTypeOf<SystemStatusSuccessResponse['checks']['database']['reason']>().toEqualTypeOf<SystemStatusReason>()
    expectTypeOf<ReturnType<typeof getDatabaseReason>>().toEqualTypeOf<SystemStatusReason>()
  })
})
