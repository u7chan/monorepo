import { type Browser, type Page, chromium } from 'playwright'
import { seedTestData, TEST_DB_PATH, TEST_PROJECT_ID } from './seed'

export { TEST_PROJECT_ID }
const workerId = Number(process.env.BUN_TEST_WORKER_ID)
const serverPort = Number.isFinite(workerId) ? 9999 + workerId : 12000 + (process.pid % 20000)
export const BASE_URL = `http://localhost:${serverPort}`

let serverProcess: ReturnType<typeof Bun.spawn> | null = null
let serverTeardownTimer: ReturnType<typeof setTimeout> | null = null
let sharedBrowser: Browser | null = null
let refCount = 0
let seeded = false

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForServerPortAvailable(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${BASE_URL}/api/projects`, { signal: AbortSignal.timeout(100) })
      await res.body?.cancel()
    } catch {
      return
    }
    await delay(100)
  }
}

async function startDevServer(): Promise<void> {
  if (!seeded) {
    seedTestData()
    seeded = true
  }

  await waitForServerPortAvailable()

  const proc = Bun.spawn(['bun', '--bun', 'vite', '--mode', 'dev', '--host', '0.0.0.0'], {
    env: { ...process.env, SERVER_PORT: String(serverPort), DATABASE_URL: TEST_DB_PATH },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  serverProcess = proc

  // Consume stdout/stderr in background to avoid pipe buffer blocking
  const decoder = new TextDecoder()
  void (async () => {
    for await (const chunk of proc.stdout) {
      decoder.decode(chunk)
    }
  })()
  void (async () => {
    for await (const chunk of proc.stderr) {
      decoder.decode(chunk)
    }
  })()

  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE_URL}/api/projects`)
      if (res.ok) return
    } catch {}
    await delay(500)
  }
  throw new Error('Dev server did not start within 30 seconds')
}

export async function setupE2E(): Promise<{ browser: Browser; page: Page }> {
  refCount++
  if (serverTeardownTimer) {
    clearTimeout(serverTeardownTimer)
    serverTeardownTimer = null
  }
  if (!serverProcess) {
    await startDevServer()
  }
  if (!sharedBrowser) {
    sharedBrowser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  }
  const page = await sharedBrowser.newPage()
  return { browser: sharedBrowser, page }
}

export async function teardownE2E(page?: Page): Promise<void> {
  if (page) await page.close()
  refCount--
  if (refCount <= 0) {
    if (sharedBrowser) {
      await sharedBrowser.close()
      sharedBrowser = null
    }
    if (serverProcess) {
      serverTeardownTimer = setTimeout(() => {
        if (refCount > 0 || !serverProcess) return
        const proc = serverProcess
        serverProcess = null
        seeded = false
        proc.kill()
      }, 2000)
    } else {
      seeded = false
    }
  }
}
