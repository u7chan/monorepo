import { vi } from 'vitest'

export function mockLogger() {
  const mock = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }

  vi.doMock('#/server/lib/logger', () => ({ logger: mock }))

  return mock
}
