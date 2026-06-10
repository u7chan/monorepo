import { and, desc, eq, isNull } from 'drizzle-orm'
import type { AppDatabase } from '#/db'
import { exportJobs } from '#/db/schema'

export function getExportJobs(db: AppDatabase, limit?: number) {
  const query = db
    .select()
    .from(exportJobs)
    .where(isNull(exportJobs.deletedAt))
    .orderBy(desc(exportJobs.createdAt))

  if (limit !== undefined) {
    return query.limit(limit).all()
  }
  return query.all()
}

export function getExportJobsByProject(db: AppDatabase, projectId: string) {
  return db
    .select()
    .from(exportJobs)
    .where(and(eq(exportJobs.projectId, projectId), isNull(exportJobs.deletedAt)))
    .orderBy(desc(exportJobs.createdAt))
    .all()
}

export function getExportJobById(db: AppDatabase, id: string) {
  return db
    .select()
    .from(exportJobs)
    .where(and(eq(exportJobs.id, id), isNull(exportJobs.deletedAt)))
    .get()
}

export function getIncompleteJobs(db: AppDatabase) {
  return db
    .select()
    .from(exportJobs)
    .where(and(isNull(exportJobs.deletedAt)))
    .all()
    .filter((j) => j.status === 'queued' || j.status === 'running' || j.status === 'canceling')
}

export function createExportJob(
  db: AppDatabase,
  data: {
    id: string
    projectId: string
    snapshot?: object
    preset?: object
  }
) {
  db.insert(exportJobs)
    .values({
      id: data.id,
      projectId: data.projectId,
      status: 'queued',
      progress: 0,
      snapshot: data.snapshot ?? null,
      preset: data.preset ?? null,
    })
    .run()
  return getExportJobById(db, data.id)!
}

export function updateExportJob(db: AppDatabase, id: string, data: Record<string, unknown>) {
  db.update(exportJobs)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(exportJobs.id, id))
    .run()
  return getExportJobById(db, id)
}

export function deleteExportJob(db: AppDatabase, id: string) {
  db.delete(exportJobs).where(eq(exportJobs.id, id)).run()
}
