import { open } from "node:fs/promises"

/**
 * Why cap the bytes the viewer inlines: the viewer sends the file body inside
 * the HTMX response, so a multi-megabyte HTML file becomes a multi-megabyte
 * DOM text node. Weak clients spend seconds laying that out (or run out of
 * memory) before the modal can paint.
 */
export const MAX_INLINE_TEXT_BYTES = 256 * 1024

/** Head that is still shown when a file exceeds `MAX_INLINE_TEXT_BYTES`. */
export const TEXT_EXCERPT_BYTES = 64 * 1024

export interface TextPreview {
  content: string
  /** True when the file holds more than `MAX_INLINE_TEXT_BYTES`. */
  truncated: boolean
  /** File size taken from the same handle that produced `content`. */
  size: number
}

/**
 * Why a bounded read instead of checking `stat().size` first: the file can be
 * replaced between the check and the read, and the viewer would then inline the
 * whole new body. This reads at most `MAX_INLINE_TEXT_BYTES + 1` bytes, so the
 * decision comes from the bytes actually read.
 */
export async function readTextPreview(
  filePath: string,
): Promise<TextPreview> {
  const handle = await open(filePath, "r")
  try {
    const { size } = await handle.stat()
    const limit = MAX_INLINE_TEXT_BYTES + 1
    const buffer = Buffer.alloc(limit)
    let bytesRead = 0
    // Why a loop: `read(2)` may return less than requested even for a regular
    // file, and a short read would look like EOF.
    while (bytesRead < limit) {
      const result = await handle.read(
        buffer,
        bytesRead,
        limit - bytesRead,
        bytesRead,
      )
      if (result.bytesRead === 0) {
        break
      }
      bytesRead += result.bytesRead
    }

    const truncated = bytesRead > MAX_INLINE_TEXT_BYTES
    const shownBytes = truncated ? TEXT_EXCERPT_BYTES : bytesRead
    // Why `stream: true`: a cut in the middle of a multi-byte character must be
    // dropped instead of decoded as U+FFFD. Without the final flush the
    // incomplete trailing sequence stays buffered and never reaches the text.
    const content = new TextDecoder("utf-8").decode(
      buffer.subarray(0, shownBytes),
      { stream: true },
    )

    return { content, truncated, size }
  } finally {
    await handle.close()
  }
}
