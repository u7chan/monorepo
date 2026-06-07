import { and, eq, isNull } from 'drizzle-orm'
import { videoAssets } from '#/db/schema'
import type { AppDatabase } from '#/db'

export function getVideoAssets(db: AppDatabase) {
  return db.select().from(videoAssets).where(isNull(videoAssets.deletedAt)).all()
}

export function getVideoAssetById(db: AppDatabase, id: string) {
  return db
    .select()
    .from(videoAssets)
    .where(and(eq(videoAssets.id, id), isNull(videoAssets.deletedAt)))
    .get()
}

export function createVideoAsset(
  db: AppDatabase,
  data: {
    id: string
    originalFilename: string
    displayName: string
    storagePath: string
    status?: string
  }
) {
  db.insert(videoAssets)
    .values({
      id: data.id,
      originalFilename: data.originalFilename,
      displayName: data.displayName,
      storagePath: data.storagePath,
      status: data.status ?? 'processing',
    })
    .run()
  return getVideoAssetById(db, data.id)!
}

export function updateVideoAsset(
  db: AppDatabase,
  id: string,
  data: Record<string, unknown>
) {
  db.update(videoAssets)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(videoAssets.id, id))
    .run()
  return getVideoAssetById(db, id)
}

export function softDeleteVideoAsset(db: AppDatabase, id: string) {
  db.update(videoAssets)
    .set({ deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(eq(videoAssets.id, id))
    .run()
}
