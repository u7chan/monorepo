import { describe, expect, test } from 'bun:test'
import { buildMp4OutputArgs, buildVideoEncodeArgs } from '#/server/features/export/export-worker'
import type { ExportPreset } from '#/shared/schemas'

describe('export worker ffmpeg args', () => {
  test('uses Windows-friendly H.264 defaults for mp4 exports', () => {
    const preset: ExportPreset = {
      format: 'mp4',
      videoCodec: 'libx264',
      audioCodec: 'aac',
      crf: 23,
      preset: 'medium',
    }

    expect(buildVideoEncodeArgs(preset)).toBe(
      '-c:v libx264 -crf 23 -preset medium -profile:v high -level 4.1 -pix_fmt yuv420p -tag:v avc1'
    )
    expect(buildMp4OutputArgs()).toBe('-movflags +faststart')
  })
})
