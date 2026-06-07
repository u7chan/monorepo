import { describe, expect, test } from 'bun:test'
import { CreateProjectSchema, CreateVideoAssetSchema, ExportPresetSchema } from '#/shared/schemas'

describe('CreateVideoAssetSchema', () => {
  test('accepts valid minimal input', () => {
    const result = CreateVideoAssetSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  test('accepts displayName', () => {
    const result = CreateVideoAssetSchema.safeParse({ displayName: 'My Video' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.displayName).toBe('My Video')
    }
  })
})

describe('CreateProjectSchema', () => {
  test('accepts valid input', () => {
    const result = CreateProjectSchema.safeParse({ name: 'Test Project', videoAssetId: 'va1' })
    expect(result.success).toBe(true)
  })

  test('rejects empty name', () => {
    const result = CreateProjectSchema.safeParse({ name: '', videoAssetId: 'va1' })
    expect(result.success).toBe(false)
  })

  test('rejects missing videoAssetId', () => {
    const result = CreateProjectSchema.safeParse({ name: 'Test' })
    expect(result.success).toBe(false)
  })
})

describe('ExportPresetSchema', () => {
  test('accepts defaults', () => {
    const result = ExportPresetSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.format).toBe('mp4')
      expect(result.data.videoCodec).toBe('libx264')
      expect(result.data.audioCodec).toBe('aac')
      expect(result.data.crf).toBe(23)
    }
  })

  test('rejects invalid codec', () => {
    const result = ExportPresetSchema.safeParse({ videoCodec: 'invalid' })
    expect(result.success).toBe(false)
  })

  test('rejects out-of-range crf', () => {
    const result = ExportPresetSchema.safeParse({ crf: 999 })
    expect(result.success).toBe(false)
  })
})
