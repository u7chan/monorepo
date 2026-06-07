import { $ } from 'bun'

export interface VideoProbeResult {
  duration: number | null
  width: number | null
  height: number | null
  fps: number | null
  codec: string | null
  hasAudio: boolean | null
  fileSize: number | null
}

export async function probeVideo(filePath: string): Promise<VideoProbeResult> {
  const cmd = `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`
  const result = await $`sh -c ${cmd}`.nothrow().quiet()

  if (result.exitCode !== 0) {
    return {
      duration: null,
      width: null,
      height: null,
      fps: null,
      codec: null,
      hasAudio: null,
      fileSize: null,
    }
  }

  try {
    const data = JSON.parse(result.stdout.toString())
    const format = data.format ?? {}
    const streams: Array<Record<string, unknown>> = data.streams ?? []

    const videoStream = streams.find(
      (s) => s.codec_type === 'video'
    ) as Record<string, unknown> | undefined
    const audioStream = streams.find((s) => s.codec_type === 'audio')

    return {
      duration: format.duration ? Number.parseFloat(format.duration as string) : null,
      width: videoStream?.width ? Number(videoStream.width) : null,
      height: videoStream?.height ? Number(videoStream.height) : null,
      fps: parseFps(videoStream),
      codec: (videoStream?.codec_name as string) ?? null,
      hasAudio: !!audioStream,
      fileSize: format.size ? Number(format.size) : null,
    }
  } catch {
    return {
      duration: null,
      width: null,
      height: null,
      fps: null,
      codec: null,
      hasAudio: null,
      fileSize: null,
    }
  }
}

function parseFps(videoStream: Record<string, unknown> | undefined): number | null {
  if (!videoStream) return null
  const rFrameRate = videoStream.r_frame_rate as string | undefined
  if (!rFrameRate) return null
  const parts = rFrameRate.split('/')
  if (parts.length === 2) {
    const num = Number(parts[0])
    const den = Number(parts[1])
    if (den !== 0) return num / den
  }
  return Number.parseFloat(rFrameRate) || null
}

export async function generateThumbnail(
  filePath: string,
  outputPath: string,
  duration: number | null
): Promise<boolean> {
  const seekTime = duration ? Math.min(duration * 0.1, 10).toFixed(1) : '1'
  const result =
    await $`ffmpeg -y -ss ${seekTime} -i "${filePath}" -vframes 1 -q:v 2 "${outputPath}"`.nothrow().quiet()

  return result.exitCode === 0
}
