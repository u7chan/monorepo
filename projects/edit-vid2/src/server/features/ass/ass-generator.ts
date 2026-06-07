import type { MappedSubtitle, SubtitleStyle } from '#/shared/schemas'

type ResolvedStyle = Omit<SubtitleStyle, 'shadow' | 'backgroundBox' | 'margin'> & {
  shadow: { enabled: boolean; color: string; offsetX: number; offsetY: number; blur: number }
  backgroundBox: { enabled: boolean; color: string; opacity: number; padding: number }
  margin: { x: number; y: number }
}

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\N')
    .replace(/\r/g, '')
}

function formatAssTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const cs = Math.round((s - Math.floor(s)) * 100)
  return `${h.toString()}:${m.toString().padStart(2, '0')}:${Math.floor(s).toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`
}

function resolveStyle(sub: MappedSubtitle, defaultStyle: SubtitleStyle): ResolvedStyle {
  const s = { ...defaultStyle, ...sub.styleOverrides }
  return {
    fontFamilyId: s.fontFamilyId ?? 'default',
    fontSize: s.fontSize ?? 48,
    fontColor: s.fontColor ?? '#FFFFFF',
    bold: s.bold ?? false,
    italic: s.italic ?? false,
    outlineColor: s.outlineColor ?? '#000000',
    outlineWidth: s.outlineWidth ?? 2,
    shadow: s.shadow ?? { enabled: false, color: '#000000', offsetX: 0, offsetY: 0, blur: 0 },
    backgroundBox: s.backgroundBox ?? { enabled: false, color: '#000000', opacity: 0.6, padding: 4 },
    position: s.position ?? 'bottom',
    margin: s.margin ?? { x: 0, y: 0 },
  }
}

function fontColorToAss(color: string): string {
  const hex = color.replace('#', '')
  if (hex.length !== 6) return '&H00FFFFFF&'
  const r = hex.substring(0, 2)
  const g = hex.substring(2, 4)
  const b = hex.substring(4, 6)
  return `&H00${b}${g}${r}&`
}

function buildAssStyle(style: ResolvedStyle): string {
  const yPos: Record<string, number> = {
    top: 50 + style.margin.y,
    center: style.margin.y,
    bottom: -50 + style.margin.y,
  }
  const marginV = yPos[style.position] ?? 0

  return [
    `Fontname=${style.fontFamilyId}`,
    `Fontsize=${style.fontSize}`,
    `PrimaryColour=${fontColorToAss(style.fontColor)}`,
    `Bold=${style.bold ? -1 : 0}`,
    `Italic=${style.italic ? -1 : 0}`,
    `Outline=${style.outlineWidth}`,
    `OutlineColour=${fontColorToAss(style.outlineColor)}`,
    `Shadow=${style.shadow.enabled ? style.shadow.blur : 0}`,
    `ShadowColour=${fontColorToAss(style.shadow.color)}`,
    `MarginL=${style.margin.x}`,
    `MarginR=${style.margin.x}`,
    `MarginV=${marginV}`,
    `Alignment=${style.position === 'top' ? 8 : style.position === 'center' ? 5 : 2}`,
  ].join(',')
}

export function generateAssContent(
  subtitles: MappedSubtitle[],
  videoWidth: number,
  videoHeight: number,
  defaultStyle: SubtitleStyle
): string {
  const lines: string[] = []

  lines.push('[Script Info]')
  lines.push('Title: edit-vid2 subtitles')
  lines.push('ScriptType: v4.00+')
  lines.push(`PlayResX: ${videoWidth}`)
  lines.push(`PlayResY: ${videoHeight}`)
  lines.push('WrapStyle: 2')
  lines.push('')

  lines.push('[V4+ Styles]')
  lines.push(
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding'
  )
  lines.push(
    `Style: Default,${buildAssStyle(resolveStyle({ text: '', outputStart: 0, outputEnd: 0, templateId: '', styleOverrides: {} }, defaultStyle))}`
  )
  lines.push('')

  lines.push('[Events]')
  lines.push('Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text')

  for (let i = 0; i < subtitles.length; i++) {
    const sub = subtitles[i]
    const style = resolveStyle(sub, defaultStyle)
    const styleName = `Style: Sub${i},${buildAssStyle(style)}`
    lines.splice(lines.indexOf('') + 1, 0, styleName)
    lines.push(
      `Dialogue: 0,${formatAssTime(sub.outputStart)},${formatAssTime(sub.outputEnd)},Sub${i},,0,0,0,,${escapeAssText(sub.text)}`
    )
  }

  return lines.join('\n')
}
