import { describe, expect, test } from 'bun:test'
import {
  getRenderableSubtitles,
  isRenderableSubtitle,
  sortSubtitleItemsByStart,
} from '#/shared/subtitles'
import type { SubtitleItem } from '#/shared/schemas'

describe('isRenderableSubtitle', () => {
  test('returns true for non-empty text', () => {
    const item: SubtitleItem = {
      id: 's1',
      sourceStart: 0,
      sourceEnd: 1,
      text: 'Hello',
      templateId: 't1',
      styleOverrides: {},
    }
    expect(isRenderableSubtitle(item)).toBe(true)
  })

  test('returns false for empty text', () => {
    const item: SubtitleItem = {
      id: 's1',
      sourceStart: 0,
      sourceEnd: 1,
      text: '',
      templateId: 't1',
      styleOverrides: {},
    }
    expect(isRenderableSubtitle(item)).toBe(false)
  })

  test('returns false for whitespace-only text', () => {
    const item: SubtitleItem = {
      id: 's1',
      sourceStart: 0,
      sourceEnd: 1,
      text: '   ',
      templateId: 't1',
      styleOverrides: {},
    }
    expect(isRenderableSubtitle(item)).toBe(false)
  })
})

describe('getRenderableSubtitles', () => {
  test('filters out empty and whitespace-only subtitles', () => {
    const items: SubtitleItem[] = [
      { id: 's1', sourceStart: 0, sourceEnd: 1, text: 'Hello', templateId: 't1', styleOverrides: {} },
      { id: 's2', sourceStart: 1, sourceEnd: 2, text: '', templateId: 't1', styleOverrides: {} },
      { id: 's3', sourceStart: 2, sourceEnd: 3, text: '   ', templateId: 't1', styleOverrides: {} },
      { id: 's4', sourceStart: 3, sourceEnd: 4, text: 'World', templateId: 't1', styleOverrides: {} },
    ]
    const result = getRenderableSubtitles(items)
    expect(result).toHaveLength(2)
    expect(result.map((item) => item.text)).toEqual(['Hello', 'World'])
  })
})

describe('sortSubtitleItemsByStart', () => {
  test('sorts items by sourceStart ascending', () => {
    const items: SubtitleItem[] = [
      { id: 's3', sourceStart: 5, sourceEnd: 7, text: 'third', templateId: 't1', styleOverrides: {} },
      { id: 's1', sourceStart: 1, sourceEnd: 3, text: 'first', templateId: 't1', styleOverrides: {} },
      { id: 's2', sourceStart: 3, sourceEnd: 5, text: 'second', templateId: 't1', styleOverrides: {} },
    ]
    const result = sortSubtitleItemsByStart(items)
    expect(result.map((item) => item.id)).toEqual(['s1', 's2', 's3'])
  })

  test('does not mutate the original array', () => {
    const items: SubtitleItem[] = [
      { id: 's2', sourceStart: 5, sourceEnd: 7, text: 'second', templateId: 't1', styleOverrides: {} },
      { id: 's1', sourceStart: 1, sourceEnd: 3, text: 'first', templateId: 't1', styleOverrides: {} },
    ]
    sortSubtitleItemsByStart(items)
    expect(items[0].id).toBe('s2')
  })

  test('returns empty array for empty input', () => {
    expect(sortSubtitleItemsByStart([])).toEqual([])
  })
})
