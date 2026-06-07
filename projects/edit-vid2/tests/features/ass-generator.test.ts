import { describe, expect, test } from 'bun:test'
import { generateAssContent } from '#/server/features/ass/ass-generator'
import type { MappedSubtitle, SubtitleStyle } from '#/shared/schemas'

const defaultStyle: SubtitleStyle = {
  fontFamilyId: 'Arial',
  fontSize: 48,
  fontColor: '#FFFFFF',
  bold: false,
  italic: false,
  outlineColor: '#000000',
  outlineWidth: 2,
  shadow: { enabled: false, color: '#000000', offsetX: 0, offsetY: 0, blur: 0 },
  backgroundBox: { enabled: false, color: '#000000', opacity: 0.6, padding: 4 },
  position: 'bottom',
  margin: { x: 10, y: 10 },
}

describe('generateAssContent', () => {
  test('generates valid ASS header with no subtitles', () => {
    const content = generateAssContent([], 1920, 1080, defaultStyle)
    expect(content).toContain('[Script Info]')
    expect(content).toContain('[V4+ Styles]')
    expect(content).toContain('[Events]')
    expect(content).toContain('PlayResX: 1920')
    expect(content).toContain('PlayResY: 1080')
    // Verify Format and Style lines exist
    expect(content).toContain('Format: Name, Fontname')
    expect(content).toContain('Style: Default')
    expect(content).toContain('Format: Layer, Start, End, Style')
  })

  test('generates subtitle dialogue lines', () => {
    const subtitles: MappedSubtitle[] = [
      { text: 'Hello', outputStart: 1, outputEnd: 3, templateId: 't1', styleOverrides: {} },
    ]
    const content = generateAssContent(subtitles, 1920, 1080, defaultStyle)
    expect(content).toContain('Style: Sub0,')
    expect(content).toContain('Dialogue: 0,')
    expect(content).toContain('Hello')
  })

  test('escapes ASS special characters', () => {
    const subtitles: MappedSubtitle[] = [
      { text: 'Line1\nLine2', outputStart: 0, outputEnd: 2, templateId: 't1', styleOverrides: {} },
    ]
    const content = generateAssContent(subtitles, 1920, 1080, defaultStyle)
    // newline should become \N in ASS
    expect(content).toContain('Line1\\NLine2')
  })

  test('Style lines are placed in [V4+ Styles] section before [Events]', () => {
    const subtitles: MappedSubtitle[] = [
      { text: 'A', outputStart: 0, outputEnd: 1, templateId: 't1', styleOverrides: {} },
      { text: 'B', outputStart: 1, outputEnd: 2, templateId: 't1', styleOverrides: {} },
    ]
    const content = generateAssContent(subtitles, 1920, 1080, defaultStyle)
    const stylesIndex = content.indexOf('[V4+ Styles]')
    const eventsIndex = content.indexOf('[Events]')
    expect(stylesIndex).toBeLessThan(eventsIndex)
    // Sub0 and Sub1 style lines should be between Styles and Events
    const sub0Index = content.indexOf('Style: Sub0')
    expect(sub0Index).toBeGreaterThan(stylesIndex)
    expect(sub0Index).toBeLessThan(eventsIndex)
  })

  test('custom style overrides are reflected in ASS', () => {
    const subtitles: MappedSubtitle[] = [
      {
        text: 'Red text',
        outputStart: 0,
        outputEnd: 2,
        templateId: 't1',
        styleOverrides: { fontColor: '#FF0000', fontSize: 60 },
      },
    ]
    const content = generateAssContent(subtitles, 1920, 1080, defaultStyle)
    // ASS color format: &H00BBGGRR&, so #FF0000 → &H000000FF&
    expect(content).toContain('&H000000FF&')
    expect(content).toContain('60')
  })

  test('bottom subtitles use a positive vertical margin', () => {
    const content = generateAssContent([], 1920, 1080, defaultStyle)
    const defaultStyleLine = content.split('\n').find((line) => line.startsWith('Style: Default,'))

    expect(defaultStyleLine).toContain(',2,10,10,60,1')
  })
})
