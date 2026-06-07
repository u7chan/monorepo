import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'
import { uuidv7 } from 'uuidv7'
import {
  createProject,
  getProjectById,
  getProjects,
  softDeleteProject,
  updateProject,
} from '#/server/features/projects/project-repository'
import type { HonoEnv } from '#/server/routes/shared'
import { CreateProjectSchema, DuplicateProjectSchema, UpdateProjectSchema } from '#/shared/schemas'

const projectRoutes = new Hono<HonoEnv>()

projectRoutes.get('/', (c) => {
  const db = c.var.db
  const list = getProjects(db)
  return c.json(list)
})

projectRoutes.get('/:projectId', (c) => {
  const db = c.var.db
  const project = getProjectById(db, c.req.param('projectId'))
  if (!project) {
    return c.json({ error: 'not found' }, 404)
  }
  return c.json(project)
})

projectRoutes.post('/', sValidator('json', CreateProjectSchema), (c) => {
  const db = c.var.db
  const body = c.req.valid('json')
  const project = createProject(db, {
    id: uuidv7(),
    videoAssetId: body.videoAssetId,
    name: body.name,
  })
  return c.json(project, 201)
})

projectRoutes.patch('/:projectId', sValidator('json', UpdateProjectSchema), (c) => {
  const db = c.var.db
  const id = c.req.param('projectId')
  const existing = getProjectById(db, id)
  if (!existing) {
    return c.json({ error: 'not found' }, 404)
  }
  const updated = updateProject(db, id, c.req.valid('json'))
  return c.json(updated)
})

projectRoutes.post('/:projectId/duplicate', sValidator('json', DuplicateProjectSchema), (c) => {
  const db = c.var.db
  const id = c.req.param('projectId')
  const existing = getProjectById(db, id)
  if (!existing) {
    return c.json({ error: 'not found' }, 404)
  }
  const body = c.req.valid('json')
  const duplicate = createProject(db, {
    id: uuidv7(),
    videoAssetId: existing.videoAssetId,
    name: body.name ?? `${existing.name} (コピー)`,
    timelineState: existing.timelineState as object | undefined,
  })
  return c.json(duplicate, 201)
})

projectRoutes.delete('/:projectId', (c) => {
  const db = c.var.db
  const id = c.req.param('projectId')
  const existing = getProjectById(db, id)
  if (!existing) {
    return c.json({ error: 'not found' }, 404)
  }
  softDeleteProject(db, id)
  return c.body(null, 204)
})

export { projectRoutes }
