import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('logger', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  it('LOG_LEVEL 環境変数でレベルを上書きできる', async () => {
    vi.stubEnv('LOG_LEVEL', 'warn')
    vi.stubEnv('NODE_ENV', 'production')
    const { logger } = await import('#/server/lib/logger')
    expect(logger.level).toBe('warn')
  })

  it('production ではデフォルト info', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const { logger } = await import('#/server/lib/logger')
    expect(logger.level).toBe('info')
  })

  it('非 production ではデフォルト debug', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const { logger } = await import('#/server/lib/logger')
    expect(logger.level).toBe('debug')
  })
})
