import { describe, expect, test } from 'bun:test'
import { normalizeKeepSegments, mapSubtitlesToOutputTime } from '#/server/features/timeline/timeline-logic'
import type { KeepSegment, SubtitleItem } from '#/shared/schemas'

describe('normalizeKeepSegments', () => {
  test('returns empty for empty input', () => {
    expect(normalizeKeepSegments([])).toEqual([])
  })

  test('returns single segment as-is', () => {
    const input: KeepSegment[] = [{ id: 'a', sourceStart: 0, sourceEnd: 10 }]
    expect(normalizeKeepSegments(input)).toEqual(input)
  })

  test('merges overlapping segments', () => {
    const input: KeepSegment[] = [
      { id: 'a', sourceStart: 0, sourceEnd: 5 },
      { id: 'b', sourceStart: 3, sourceEnd: 10 },
    ]
    const result = normalizeKeepSegments(input)
    expect(result).toHaveLength(1)
    expect(result[0].sourceStart).toBe(0)
    expect(result[0].sourceEnd).toBe(10)
  })

  test('merges adjacent segments', () => {
    const input: KeepSegment[] = [
      { id: 'a', sourceStart: 0, sourceEnd: 5 },
      { id: 'b', sourceStart: 5, sourceEnd: 10 },
    ]
    const result = normalizeKeepSegments(input)
    expect(result).toHaveLength(1)
    expect(result[0].sourceStart).toBe(0)
    expect(result[0].sourceEnd).toBe(10)
  })

  test('keeps non-overlapping segments separate', () => {
    const input: KeepSegment[] = [
      { id: 'a', sourceStart: 0, sourceEnd: 5 },
      { id: 'b', sourceStart: 10, sourceEnd: 15 },
    ]
    const result = normalizeKeepSegments(input)
    expect(result).toHaveLength(2)
  })

  test('sorts unsorted input', () => {
    const input: KeepSegment[] = [
      { id: 'b', sourceStart: 10, sourceEnd: 15 },
      { id: 'a', sourceStart: 0, sourceEnd: 5 },
    ]
    const result = normalizeKeepSegments(input)
    expect(result[0].sourceStart).toBe(0)
    expect(result[1].sourceStart).toBe(10)
  })
})

describe('mapSubtitlesToOutputTime', () => {
  test('passes through when no keepSegments (no trim)', () => {
    const subtitles: SubtitleItem[] = [
      { id: 's1', sourceStart: 1, sourceEnd: 5, text: 'Hello', templateId: 't1', styleOverrides: {} },
    ]
    const result = mapSubtitlesToOutputTime(subtitles, [])
    expect(result).toHaveLength(1)
    expect(result[0].outputStart).toBe(1)
    expect(result[0].outputEnd).toBe(5)
    expect(result[0].text).toBe('Hello')
  })

  test('maps simple case with single keepSegment', () => {
    const subtitles: SubtitleItem[] = [
      { id: 's1', sourceStart: 2, sourceEnd: 6, text: 'Hello', templateId: 't1', styleOverrides: {} },
    ]
    const keepSegments: KeepSegment[] = [
      { id: 'k1', sourceStart: 0, sourceEnd: 10 },
    ]
    const result = mapSubtitlesToOutputTime(subtitles, keepSegments)
    expect(result).toHaveLength(1)
    expect(result[0].outputStart).toBe(2)
    expect(result[0].outputEnd).toBe(6)
  })

  test('shifts time when keepSegment starts after 0', () => {
    const subtitles: SubtitleItem[] = [
      { id: 's1', sourceStart: 5, sourceEnd: 10, text: 'Hello', templateId: 't1', styleOverrides: {} },
    ]
    const keepSegments: KeepSegment[] = [
      { id: 'k1', sourceStart: 5, sourceEnd: 15 },
    ]
    const result = mapSubtitlesToOutputTime(subtitles, keepSegments)
    expect(result).toHaveLength(1)
    expect(result[0].outputStart).toBe(0)
    expect(result[0].outputEnd).toBe(5)
  })

  test('splits subtitle crossing a cut boundary', () => {
    const subtitles: SubtitleItem[] = [
      { id: 's1', sourceStart: 4, sourceEnd: 7, text: 'Hello', templateId: 't1', styleOverrides: {} },
    ]
    const keepSegments: KeepSegment[] = [
      { id: 'k1', sourceStart: 0, sourceEnd: 5 },
      { id: 'k2', sourceStart: 6, sourceEnd: 10 },
    ]
    const result = mapSubtitlesToOutputTime(subtitles, keepSegments)
    expect(result).toHaveLength(2)
    expect(result[0].outputStart).toBe(4)
    expect(result[0].outputEnd).toBe(5)
    expect(result[1].outputStart).toBeCloseTo(5)
    expect(result[1].outputEnd).toBeCloseTo(6)
  })

  test('excludes subtitle completely outside keepSegments', () => {
    const subtitles: SubtitleItem[] = [
      { id: 's1', sourceStart: 5, sourceEnd: 6, text: 'Hello', templateId: 't1', styleOverrides: {} },
    ]
    const keepSegments: KeepSegment[] = [
      { id: 'k1', sourceStart: 0, sourceEnd: 4 },
      { id: 'k2', sourceStart: 7, sourceEnd: 10 },
    ]
    const result = mapSubtitlesToOutputTime(subtitles, keepSegments)
    expect(result).toHaveLength(0)
  })
})
