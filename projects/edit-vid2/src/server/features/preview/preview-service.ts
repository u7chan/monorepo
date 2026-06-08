import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { $ } from 'bun'
import { generateAssContent } from '#/server/features/ass/ass-generator'
import type { SubtitleStyle } from '#/shared/schemas'

export function buildPreviewCacheKey(
  projectId: string,
  videoAssetId: string,
  sourceTime: number,
  template: SubtitleStyle,
  text: string,
  renderVersion: number
): string {
  const payload = `${projectId}:${videoAssetId}:${sourceTime}:${JSON.stringify(template)}:${text}:${renderVersion}`
  return createHash('sha256').update(payload).digest('hex').substring(0, 16)
}

export async function generateSubtitlePreview(params: {
  videoPath: string
  outputPath: string
  sourceTime: number
  text: string
  videoWidth: number
  videoHeight: number
  defaultStyle: SubtitleStyle
}): Promise<boolean> {
  const { videoPath, outputPath, sourceTime, text, videoWidth, videoHeight, defaultStyle } = params

  const dir = outputPath.substring(0, outputPath.lastIndexOf('/'))
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const assContent = generateAssContent(
    [{ text, outputStart: 0, outputEnd: 1, templateId: '', styleOverrides: {} }],
    videoWidth,
    videoHeight,
    defaultStyle
  )

  const assPath = outputPath.replace(/\.\w+$/, '.ass')
  writeFileSync(assPath, assContent)

  const result =
    await $`ffmpeg -y -ss ${sourceTime.toFixed(2)} -i "${videoPath}" -vf "subtitles=${assPath}" -vframes 1 -q:v 2 "${outputPath}"`
      .nothrow()
      .quiet()

  // Clean up ASS temp
  try {
    unlinkSync(assPath)
  } catch {}

  return result.exitCode === 0
}
