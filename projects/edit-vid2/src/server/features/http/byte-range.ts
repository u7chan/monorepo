export type ByteRange =
  | { ok: true; start: number; end: number; length: number }
  | { ok: false; reason: 'invalid' | 'unsatisfiable' }

export function parseByteRange(rangeHeader: string, size: number): ByteRange {
  const match = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/)
  if (!match) {
    return { ok: false, reason: 'invalid' }
  }

  const [, startStr, endStr] = match

  if (startStr === '' && endStr === '') {
    return { ok: false, reason: 'invalid' }
  }

  if (startStr === '') {
    const suffixLength = Number.parseInt(endStr, 10)
    if (Number.isNaN(suffixLength) || suffixLength <= 0) {
      return { ok: false, reason: 'invalid' }
    }
    if (size === 0) {
      return { ok: false, reason: 'unsatisfiable' }
    }
    const start = Math.max(0, size - suffixLength)
    const end = size - 1
    return { ok: true, start, end, length: end - start + 1 }
  }

  const start = Number.parseInt(startStr, 10)
  if (Number.isNaN(start) || start < 0) {
    return { ok: false, reason: 'invalid' }
  }

  const endExplicit = endStr !== ''
  let end = endExplicit ? Number.parseInt(endStr, 10) : size - 1
  if (Number.isNaN(end) || (endExplicit && end < 0)) {
    return { ok: false, reason: 'invalid' }
  }

  if (end >= size) {
    end = size - 1
  }

  if (start > end || start >= size) {
    return { ok: false, reason: 'unsatisfiable' }
  }

  return { ok: true, start, end, length: end - start + 1 }
}
