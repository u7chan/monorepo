import type { KeepSegment, MappedSubtitle, SubtitleItem } from '#/shared/schemas'

export function normalizeKeepSegments(segments: KeepSegment[]): KeepSegment[] {
  if (segments.length === 0) return []
  const sorted = [...segments].sort((a, b) => a.sourceStart - b.sourceStart)
  const merged: KeepSegment[] = [sorted[0]]

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1]
    const curr = sorted[i]
    if (curr.sourceStart <= last.sourceEnd) {
      last.sourceEnd = Math.max(last.sourceEnd, curr.sourceEnd)
    } else {
      merged.push(curr)
    }
  }

  return merged
}

export function mapSubtitlesToOutputTime(
  subtitles: SubtitleItem[],
  keepSegments: KeepSegment[]
): MappedSubtitle[] {
  const normalized = normalizeKeepSegments(keepSegments)

  if (normalized.length === 0) return []

  // Build time offset map: sourceTime → outputTime
  let outputOffset = 0
  const offsetMap: Array<{ sourceStart: number; offset: number }> = []

  for (const seg of normalized) {
    offsetMap.push({ sourceStart: seg.sourceStart, offset: outputOffset - seg.sourceStart })
    outputOffset += seg.sourceEnd - seg.sourceStart
  }

  function sourceToOutput(sourceTime: number): number {
    for (let i = offsetMap.length - 1; i >= 0; i--) {
      const entry = offsetMap[i]
      if (sourceTime >= entry.sourceStart) {
        return sourceTime + entry.offset
      }
    }
    return sourceTime
  }

  const result: MappedSubtitle[] = []

  for (const sub of subtitles) {
    for (const seg of normalized) {
      const intersectStart = Math.max(sub.sourceStart, seg.sourceStart)
      const intersectEnd = Math.min(sub.sourceEnd, seg.sourceEnd)

      if (intersectStart < intersectEnd) {
        result.push({
          text: sub.text,
          outputStart: sourceToOutput(intersectStart),
          outputEnd: sourceToOutput(intersectEnd),
          templateId: sub.templateId,
          styleOverrides: sub.styleOverrides,
        })
      }
    }
  }

  return result
}
