import { describe, expect, it } from 'vitest'
import { formatSystemStatusForCopy } from '#/client/features/home/system-status-widget'
import type { SystemStatus } from '#/types'

const checkedAt = '2026-04-19T00:00:00.000Z'

function createStatus(): SystemStatus {
  return {
    status: 'ok',
    checkedAt,
    checks: {
      database: {
        status: 'ok',
        reason: 'ok',
        checkedAt,
        connection: { status: 'ok', reason: 'ok', checkedAt },
        schema: { status: 'ok', reason: 'ok', checkedAt },
      },
      fileServerHealth: { status: 'ok', reason: 'ok', checkedAt },
      fileServerApi: {
        status: 'ok',
        reason: 'ok',
        checkedAt,
        login: { status: 'ok', reason: 'ok', checkedAt },
        read: { status: 'ok', reason: 'ok', checkedAt },
      },
      fileServerPublic: { status: 'ok', reason: 'ok', checkedAt },
    },
  }
}

describe('formatSystemStatusForCopy', () => {
  it('正常状態の全チェックをraw値とMarkdownの階層で出力する', () => {
    expect(formatSystemStatusForCopy(createStatus())).toBe(`# System status
- status: ok
- checkedAt: ${checkedAt}

## Checks

### PostgreSQL (\`checks.database\`)

- status: ok
- reason: ok
- checkedAt: ${checkedAt}

#### connection

- status: ok
- reason: ok
- checkedAt: ${checkedAt}

#### schema

- status: ok
- reason: ok
- checkedAt: ${checkedAt}

### file-server 稼働 (\`checks.fileServerHealth\`)

- status: ok
- reason: ok
- checkedAt: ${checkedAt}

### file-server API (\`checks.fileServerApi\`)

- status: ok
- reason: ok
- checkedAt: ${checkedAt}

#### login

- status: ok
- reason: ok
- checkedAt: ${checkedAt}

#### read

- status: ok
- reason: ok
- checkedAt: ${checkedAt}

### 公開URL (\`checks.fileServerPublic\`)

- status: ok
- reason: ok
- checkedAt: ${checkedAt}
`)
  })

  it('degraded状態でも親子チェックのraw statusとreasonを保持する', () => {
    const status = createStatus()
    status.status = 'degraded'
    status.checks.database.status = 'error'
    status.checks.database.reason = 'database-unavailable'
    status.checks.database.connection.status = 'error'
    status.checks.database.connection.reason = 'connection-failed'
    status.checks.fileServerApi.read.status = 'error'
    status.checks.fileServerApi.read.reason = 'read-failed'

    const output = formatSystemStatusForCopy(status)

    expect(output).toContain('- status: degraded')
    expect(output).toContain('### PostgreSQL (`checks.database`)\n\n- status: error\n- reason: database-unavailable')
    expect(output).toContain('#### connection\n\n- status: error\n- reason: connection-failed')
    expect(output).toContain('#### read\n\n- status: error\n- reason: read-failed')
    expect(output).toContain(`- checkedAt: ${checkedAt}`)
  })

  it('欠落したoptional checkを省略し、残ったnested checkを保持する', () => {
    const status = createStatus()
    const output = formatSystemStatusForCopy({
      status: 'degraded',
      checkedAt,
      checks: {
        fileServerApi: {
          ...status.checks.fileServerApi,
          login: undefined,
        },
      },
    })

    expect(output).toContain('# System status\n- status: degraded')
    expect(output).toContain('### file-server API (`checks.fileServerApi`)')
    expect(output).toContain('#### read')
    expect(output).not.toContain('### PostgreSQL')
    expect(output).not.toContain('### file-server 稼働')
    expect(output).not.toContain('#### login')
    expect(output).not.toContain('### 公開URL')
  })
})
