import { copyFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { getDatabase } from '#/db'
import { projects, videoAssets } from '#/db/schema'

export const TEST_VIDEO_ID = 'e2e-test-video'
export const TEST_PROJECT_ID = 'e2e-test-project'
const E2E_WORKER_KEY = (process.env.BUN_TEST_WORKER_ID ?? String(process.pid)).replace(/[^a-zA-Z0-9_-]/g, '-')
export const TEST_DB_PATH = `/tmp/edit-vid2-test-${E2E_WORKER_KEY}.db`
const TEST_VIDEO_DIR = `data/videos/e2e-test-video-${E2E_WORKER_KEY}`

export function seedTestData() {
  try {
    unlinkSync(TEST_DB_PATH)
  } catch {}

  const db = getDatabase(TEST_DB_PATH)
  migrate(db, { migrationsFolder: './drizzle' })

  mkdirSync(TEST_VIDEO_DIR, { recursive: true })
  copyFileSync('tests/fixtures/test-compat.mp4', join(TEST_VIDEO_DIR, 'source.mp4'))

  db.insert(videoAssets)
    .values({
      id: TEST_VIDEO_ID,
      originalFilename: 'test-compat.mp4',
      displayName: 'E2E Test Video',
      storagePath: `${TEST_VIDEO_DIR}/source.mp4`,
      status: 'ready',
      duration: 5.0,
      width: 320,
      height: 240,
      fps: 30,
      codec: 'h264',
      hasAudio: true,
    })
    .run()

  db.insert(projects)
    .values({
      id: TEST_PROJECT_ID,
      videoAssetId: TEST_VIDEO_ID,
      name: 'E2E Test Project',
    })
    .run()

  db.$client.close()
}
