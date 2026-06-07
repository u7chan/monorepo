import type { MappedSubtitle, SubtitleStyle } from '#/shared/schemas'

type ResolvedStyle = Omit<SubtitleStyle, 'shadow' | 'backgroundBox' | 'margin'> & {
  shadow: { enabled: boolean; color: string; offsetX: number; offsetY: number; blur: number }
  backgroundBox: { enabled: boolean; color: string; opacity: number; padding: number }
  margin: { x: number; y: number }
}

const ASS_NEWLINE_MARKER = '\x00N'

function escapeAssText(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/\n/g, ASS_NEWLINE_MARKER)
    .replace(/\\/g, '\\\\')
    .replace(new RegExp(ASS_NEWLINE_MARKER, 'g'), '\\N')
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

function buildAssStyleLine(name: string, style: ResolvedStyle): string {
  const yPos: Record<string, number> = {
    top: 50 + style.margin.y,
    center: style.margin.y,
    bottom: -50 + style.margin.y,
  }
  const marginV = Math.round(yPos[style.position] ?? 0)
  const alignment = style.position === 'top' ? 8 : style.position === 'center' ? 5 : 2

  // Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,
  // Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle,
  // Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
  return [
    `Style: ${name}`,
    style.fontFamilyId,
    style.fontSize,
    fontColorToAss(style.fontColor),
    '&H000000FF',
    fontColorToAss(style.outlineColor),
    style.backgroundBox.enabled ? fontColorToAss(style.backgroundBox.color) : '&H00000000',
    style.bold ? -1 : 0,
    style.italic ? -1 : 0,
    0, // Underline
    0, // StrikeOut
    100, // ScaleX
    100, // ScaleY
    0, // Spacing
    0, // Angle
    1, // BorderStyle
    style.outlineWidth,
    style.shadow.enabled ? style.shadow.blur : 0,
    alignment,
    Math.round(style.margin.x),
    Math.round(style.margin.x),
    marginV,
    1, // Encoding
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
    buildAssStyleLine(
      'Default',
      resolveStyle({ text: '', outputStart: 0, outputEnd: 0, templateId: '', styleOverrides: {} }, defaultStyle)
    )
  )

  // Collect per-subtitle style lines
  const styleLines: string[] = []
  for (let i = 0; i < subtitles.length; i++) {
    const style = resolveStyle(subtitles[i], defaultStyle)
    styleLines.push(buildAssStyleLine(`Sub${i}`, style))
  }

  lines.push(...styleLines)
  lines.push('')

  lines.push('[Events]')
  lines.push('Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text')

  for (let i = 0; i < subtitles.length; i++) {
    const sub = subtitles[i]
    lines.push(
      `Dialogue: 0,${formatAssTime(sub.outputStart)},${formatAssTime(sub.outputEnd)},Sub${i},,0,0,0,,${escapeAssText(sub.text)}`
    )
  }

  return lines.join('\n')
}
