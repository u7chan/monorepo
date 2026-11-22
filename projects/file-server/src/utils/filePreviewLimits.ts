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

/**
 * Why not `readFile(path, "utf-8")` with a slice afterwards: that still reads
 * and decodes the whole file, which is what the cap is meant to avoid.
 */
export async function readFileHead(
  filePath: string,
  maxBytes: number,
): Promise<string> {
  const handle = await open(filePath, "r")
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    // Why `stream: true`: a cut in the middle of a multi-byte character must be
    // dropped instead of decoded as U+FFFD. Without the final flush the
    // incomplete trailing sequence stays buffered and never reaches the text.
    return new TextDecoder("utf-8").decode(buffer.subarray(0, bytesRead), {
      stream: true,
    })
  } finally {
    await handle.close()
  }
}
