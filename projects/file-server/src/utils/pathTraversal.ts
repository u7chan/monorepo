import path from "node:path"

export function isPathTraversal(p: string): boolean {
  if (!p) {
    return false
  }

  const slashed = p.replaceAll("\\", "/")

  // Why not rely on path.posix.normalize alone: normalization erases the `..`
  // segment, but authorization runs on the un-normalized `parts`, so
  // `private/alice/../admin/x` would pass as alice's path and then resolve into
  // admin's directory. A NUL byte also has to stop here because fs.stat throws
  // ERR_INVALID_ARG_VALUE on it instead of returning ENOENT.
  if (slashed.includes("\0") || slashed.split("/").includes("..")) {
    return true
  }

  const normalized = path.posix.normalize(slashed)
  const hasParentReference =
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..")

  return (
    hasParentReference ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(p)
  )
}
