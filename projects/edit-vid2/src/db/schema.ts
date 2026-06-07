import { sql } from 'drizzle-orm'
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// ── VideoAsset ──────────────────────────────────────────────

export const videoAssets = sqliteTable('video_assets', {
  id: text('id').primaryKey(),
  originalFilename: text('original_filename').notNull(),
  displayName: text('display_name').notNull(),
  storagePath: text('storage_path').notNull(),
  thumbnailPath: text('thumbnail_path'),
  duration: real('duration'),
  width: integer('width'),
  height: integer('height'),
  fps: real('fps'),
  codec: text('codec'),
  hasAudio: integer('has_audio', { mode: 'boolean' }),
  fileSize: integer('file_size'),
  status: text('status').notNull().default('processing'), // uploading | processing | ready | failed
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  deletedAt: text('deleted_at'),
})

// ── Project ─────────────────────────────────────────────────

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  videoAssetId: text('video_asset_id')
    .notNull()
    .references(() => videoAssets.id),
  name: text('name').notNull(),
  timelineState: text('timeline_state', { mode: 'json' }).$type<object>(),
  timelineStateVersion: integer('timeline_state_version').notNull().default(1),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  deletedAt: text('deleted_at'),
})

// ── SubtitleTemplate ────────────────────────────────────────

export const subtitleTemplates = sqliteTable('subtitle_templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  fontFamilyId: text('font_family_id').notNull().default('default'),
  fontSize: integer('font_size').notNull().default(48),
  fontColor: text('font_color').notNull().default('#FFFFFF'),
  bold: integer('bold', { mode: 'boolean' }).notNull().default(false),
  italic: integer('italic', { mode: 'boolean' }).notNull().default(false),
  outlineColor: text('outline_color').notNull().default('#000000'),
  outlineWidth: real('outline_width').notNull().default(2),
  shadowEnabled: integer('shadow_enabled', { mode: 'boolean' }).notNull().default(false),
  shadowColor: text('shadow_color').notNull().default('#000000'),
  shadowOffsetX: real('shadow_offset_x').notNull().default(0),
  shadowOffsetY: real('shadow_offset_y').notNull().default(0),
  shadowBlur: real('shadow_blur').notNull().default(0),
  backgroundBoxEnabled: integer('background_box_enabled', { mode: 'boolean' }).notNull().default(false),
  backgroundBoxColor: text('background_box_color').notNull().default('#000000'),
  backgroundBoxOpacity: real('background_box_opacity').notNull().default(0.6),
  backgroundBoxPadding: real('background_box_padding').notNull().default(4),
  position: text('position').notNull().default('bottom'), // top | center | bottom
  marginX: real('margin_x').notNull().default(0),
  marginY: real('margin_y').notNull().default(0),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  deletedAt: text('deleted_at'),
})

// ── ProjectTemplate (join) ──────────────────────────────────

export const projectTemplates = sqliteTable('project_templates', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  templateId: text('template_id')
    .notNull()
    .references(() => subtitleTemplates.id),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
})

// ── ExportJob ───────────────────────────────────────────────

export const exportJobs = sqliteTable('export_jobs', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  status: text('status').notNull().default('queued'), // queued | running | succeeded | failed | canceling | canceled
  progress: real('progress').notNull().default(0),
  snapshot: text('snapshot', { mode: 'json' }).$type<object>(),
  preset: text('preset', { mode: 'json' }).$type<object>(),
  outputPath: text('output_path'),
  logPath: text('log_path'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  deletedAt: text('deleted_at'),
})
