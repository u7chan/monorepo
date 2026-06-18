import { describe, expect, test } from 'bun:test'
import { parseByteRange } from '#/server/features/http/byte-range'

describe('parseByteRange', () => {
  const size = 100

  test('returns invalid for missing or malformed header', () => {
    expect(parseByteRange('', size)).toEqual({ ok: false, reason: 'invalid' })
    expect(parseByteRange('bytes=', size)).toEqual({ ok: false, reason: 'invalid' })
    expect(parseByteRange('bytes=-', size)).toEqual({ ok: false, reason: 'invalid' })
    expect(parseByteRange('bytes=0-1,2-3', size)).toEqual({ ok: false, reason: 'invalid' })
    expect(parseByteRange('bytes=0-1-2', size)).toEqual({ ok: false, reason: 'invalid' })
    expect(parseByteRange('items=0-1', size)).toEqual({ ok: false, reason: 'invalid' })
    expect(parseByteRange('bytes=0--1', size)).toEqual({ ok: false, reason: 'invalid' })
  })

  test('returns full range when no range header is not applicable', () => {
    expect(parseByteRange('bytes=0-99', size)).toEqual({ ok: true, start: 0, end: 99, length: 100 })
  })

  test('normalizes closed range', () => {
    expect(parseByteRange('bytes=0-3', size)).toEqual({ ok: true, start: 0, end: 3, length: 4 })
  })

  test('normalizes open-ended range to file end', () => {
    expect(parseByteRange('bytes=4-', size)).toEqual({ ok: true, start: 4, end: 99, length: 96 })
  })

  test('normalizes suffix range to last N bytes', () => {
    expect(parseByteRange('bytes=-4', size)).toEqual({ ok: true, start: 96, end: 99, length: 4 })
  })

  test('clamps end beyond size to file end', () => {
    expect(parseByteRange('bytes=0-999999999', size)).toEqual({ ok: true, start: 0, end: 99, length: 100 })
  })

  test('clamps suffix larger than size to full file', () => {
    expect(parseByteRange('bytes=-999999999', size)).toEqual({ ok: true, start: 0, end: 99, length: 100 })
  })

  test('rejects suffix of zero bytes', () => {
    expect(parseByteRange('bytes=-0', size)).toEqual({ ok: false, reason: 'invalid' })
  })

  test('rejects start equal to size', () => {
    expect(parseByteRange('bytes=100-', size)).toEqual({ ok: false, reason: 'unsatisfiable' })
    expect(parseByteRange('bytes=100-100', size)).toEqual({ ok: false, reason: 'unsatisfiable' })
  })

  test('rejects start greater than end', () => {
    expect(parseByteRange('bytes=5-3', size)).toEqual({ ok: false, reason: 'unsatisfiable' })
  })

  test('rejects start beyond size', () => {
    expect(parseByteRange('bytes=101-105', size)).toEqual({ ok: false, reason: 'unsatisfiable' })
  })

  test('rejects negative start', () => {
    expect(parseByteRange('bytes=-1-5', size)).toEqual({ ok: false, reason: 'invalid' })
  })

  test('handles empty file as unsatisfiable for any range', () => {
    expect(parseByteRange('bytes=0-', 0)).toEqual({ ok: false, reason: 'unsatisfiable' })
    expect(parseByteRange('bytes=-1', 0)).toEqual({ ok: false, reason: 'unsatisfiable' })
  })

  test('returns full range when suffix equals size', () => {
    expect(parseByteRange('bytes=-100', size)).toEqual({ ok: true, start: 0, end: 99, length: 100 })
  })

  test('trims whitespace around header', () => {
    expect(parseByteRange('  bytes=0-3  ', size)).toEqual({ ok: true, start: 0, end: 3, length: 4 })
  })
})
