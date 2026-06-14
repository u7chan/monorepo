import type { SubtitleItem } from './schemas'

export function isRenderableSubtitle(item: SubtitleItem): boolean {
  return item.text.trim().length > 0
}

export function getRenderableSubtitles(items: SubtitleItem[]): SubtitleItem[] {
  return items.filter(isRenderableSubtitle)
}

export function sortSubtitleItemsByStart(items: SubtitleItem[]): SubtitleItem[] {
  return [...items].sort((a, b) => a.sourceStart - b.sourceStart)
}
