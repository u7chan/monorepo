import { randomUUID } from "node:crypto"
import { rename, rm, writeFile } from "node:fs/promises"
import * as path from "node:path"

/**
 * Replace a file through a temporary name in the same directory.
 *
 * Why not `writeFile(target)`: it truncates the existing inode, so a preview
 * or download that already opened the file sees the new short content and ends
 * before its `Content-Length`. Publishing with `rename()` swaps the directory
 * entry instead, and an in-flight reader keeps the old inode it opened.
 */
export async function writeFileAtomic(
  targetPath: string,
  data: string | Uint8Array,
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${randomUUID()}.tmp`,
  )

  try {
    if (typeof data === "string") {
      await writeFile(temporaryPath, data, "utf-8")
    } else {
      await writeFile(temporaryPath, data)
    }
    await rename(temporaryPath, targetPath)
  } catch (error) {
    // Why ignore the cleanup error: the original failure is the one the caller
    // has to see; a leftover temp file must not replace it.
    await rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}
