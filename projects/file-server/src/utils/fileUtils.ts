import { stat as fsStat } from "node:fs/promises"
import * as path from "node:path"

export function isInvalidPath(p: string): boolean {
  return p.includes("..") || path.isAbsolute(p) || p.startsWith("/")
}

export async function resolveUploadPath(
  baseDir: string,
  filePathParam: string | undefined,
  fileName: string,
): Promise<string> {
  if (!filePathParam || filePathParam === "") return fileName
  const fullPath = path.join(baseDir, filePathParam)
  try {
    const stat = await fsStat(fullPath)
    if (stat.isDirectory()) {
      return path.join(filePathParam, fileName)
    } else {
      return filePathParam
    }
  } catch {
    if (filePathParam.endsWith("/")) {
      return filePathParam + fileName
    }
    return filePathParam
  }
}

export function sortFiles<T extends { name: string; type: "file" | "dir" }>(
  files: T[],
): T[] {
  return [...files].sort((a, b) => {
    if (a.type === "dir" && b.type === "file") {
      return -1
    }
    if (a.type === "file" && b.type === "dir") {
      return 1
    }
    return a.name.localeCompare(b.name)
  })
}
