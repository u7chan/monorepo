import { and, eq, isNull } from 'drizzle-orm'
import type { AppDatabase } from '#/db'
import { projects } from '#/db/schema'

export function getProjects(db: AppDatabase) {
  return db.select().from(projects).where(isNull(projects.deletedAt)).all()
}

export function getProjectById(db: AppDatabase, id: string) {
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
    .get()
}

export function getProjectsByVideoAssetId(db: AppDatabase, videoAssetId: string) {
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.videoAssetId, videoAssetId), isNull(projects.deletedAt)))
    .all()
}

export function createProject(
  db: AppDatabase,
  data: {
    id: string
    videoAssetId: string
    name: string
    timelineState?: object
  }
) {
  db.insert(projects)
    .values({
      id: data.id,
      videoAssetId: data.videoAssetId,
      name: data.name,
      timelineState: data.timelineState ?? null,
    })
    .run()
  return getProjectById(db, data.id)!
}

export function updateProject(db: AppDatabase, id: string, data: Record<string, unknown>) {
  db.update(projects)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(projects.id, id))
    .run()
  return getProjectById(db, id)
}

export function softDeleteProject(db: AppDatabase, id: string) {
  db.update(projects)
    .set({ deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(eq(projects.id, id))
    .run()
}
