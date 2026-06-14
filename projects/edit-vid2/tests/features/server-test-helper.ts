import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { testClient } from 'hono/testing'
import { getDatabase } from '#/db'
import type { AppDatabase } from '#/db'
import { exportJobs, projects, subtitleTemplates, videoAssets } from '#/db/schema'
import { createApp } from '#/server/app'

type TestServerOptions = Parameters<typeof createApp>[0]

export function createTestServer(options: TestServerOptions = {}) {
  const dbPath = join(tmpdir(), `edit-vid2-server-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const db = getDatabase(dbPath)
  migrate(db, { migrationsFolder: './drizzle' })
  const app = createApp({ ...options, db })
  const client = testClient(app)

  function cleanup() {
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        rmSync(path, { force: true })
      } catch {}
    }
  }

  return { app, client, db, dbPath, cleanup }
}

export function seedVideoAsset(
  db: AppDatabase,
  overrides: Partial<typeof videoAssets.$inferInsert> = {}
): typeof videoAssets.$inferSelect {
  const value = {
    id: 'video-1',
    originalFilename: 'source.mp4',
    displayName: 'Source Video',
    storagePath: 'data/videos/video-1/source.mp4',
    status: 'ready',
    width: 1920,
    height: 1080,
    ...overrides,
  }
  db.insert(videoAssets).values(value).run()
  return db.select().from(videoAssets).where(eq(videoAssets.id, value.id)).get()!
}

export function seedProject(
  db: AppDatabase,
  overrides: Partial<typeof projects.$inferInsert> = {}
): typeof projects.$inferSelect {
  const value = {
    id: 'project-1',
    videoAssetId: 'video-1',
    name: 'Project',
    ...overrides,
  }
  db.insert(projects).values(value).run()
  return db.select().from(projects).where(eq(projects.id, value.id)).get()!
}

export function seedTemplate(
  db: AppDatabase,
  overrides: Partial<typeof subtitleTemplates.$inferInsert> = {}
): typeof subtitleTemplates.$inferSelect {
  const value = {
    id: 'template-1',
    name: 'Template',
    ...overrides,
  }
  db.insert(subtitleTemplates).values(value).run()
  return db.select().from(subtitleTemplates).where(eq(subtitleTemplates.id, value.id)).get()!
}

export function seedExportJob(
  db: AppDatabase,
  overrides: Partial<typeof exportJobs.$inferInsert> = {}
): typeof exportJobs.$inferSelect {
  const value = {
    id: 'job-1',
    projectId: 'project-1',
    status: 'queued',
    ...overrides,
  }
  db.insert(exportJobs).values(value).run()
  return db.select().from(exportJobs).where(eq(exportJobs.id, value.id)).get()!
}
