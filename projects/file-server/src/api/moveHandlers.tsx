import { stat as fsStat } from "node:fs/promises"
import * as path from "node:path"
import type { Context } from "hono"
import { MovePickerModal } from "../components/file-list/MovePickerModal"
import type { AppBindings } from "../types"
import {
  alreadyExistsResponse,
  renderFileListResponse,
} from "../utils/apiHelpers"
import { getFileList } from "../utils/fileListing"
import { normalizeRelativePath } from "../utils/fileUtils"
import { mapMovePathError, movePath } from "../utils/fsMove"
import {
  checkCrossScopeMove,
  getMovePickerRoots,
  getMoveScope,
  isWithinVirtualPath,
} from "../utils/moveScope"
import { isNodeErrorCode } from "../utils/nodeError"
import { isPathTraversal } from "../utils/pathTraversal"
import {
  errorResponse,
  forbiddenResponse,
  getUploadDir,
  getUser,
  invalidPathResponse,
} from "../utils/requestUtils"
import {
  requireWritePermission,
  resolveVirtualPath,
} from "../utils/virtualPath"

function containsParentSegment(p: string): boolean {
  return p
    .replaceAll("\\", "/")
    .split("/")
    .some((seg) => seg === "..")
}

export async function moveHandler(c: Context<AppBindings>) {
  const validatedData = c.req.valid("form" as never) as {
    path: string
    destination: string
  }
  const { path: sourcePathParam, destination: destinationParam } = validatedData
  const baseDir = getUploadDir(c)
  const user = getUser(c)

  if (isPathTraversal(sourcePathParam) || isPathTraversal(destinationParam)) {
    return invalidPathResponse(c)
  }

  const normalizedSource = normalizeRelativePath(sourcePathParam)
  const normalizedDestination = normalizeRelativePath(destinationParam)

  if (!normalizedSource) {
    return invalidPathResponse(c)
  }

  if (!requireWritePermission(user, normalizedSource)) {
    return forbiddenResponse(c)
  }
  if (!requireWritePermission(user, normalizedDestination)) {
    return forbiddenResponse(c)
  }

  const crossScopeError = checkCrossScopeMove(
    user,
    normalizedSource,
    normalizedDestination,
  )
  if (crossScopeError) {
    return errorResponse(
      c,
      crossScopeError.name,
      crossScopeError.message,
      crossScopeError.status,
    )
  }

  const sourcePath = path.join(baseDir, normalizedSource)
  let sourceStat: Awaited<ReturnType<typeof fsStat>>
  try {
    sourceStat = await fsStat(sourcePath)
  } catch (err: unknown) {
    if (isNodeErrorCode(err, "ENOENT")) {
      return errorResponse(
        c,
        "FileNotFound",
        "File or directory does not exist",
        400,
      )
    }
    throw err
  }

  const destinationDirPath = path.join(baseDir, normalizedDestination)
  try {
    const destStat = await fsStat(destinationDirPath)
    if (!destStat.isDirectory()) {
      return errorResponse(
        c,
        "DestNotDirectory",
        "Destination is not a directory",
        400,
      )
    }
  } catch (err: unknown) {
    if (isNodeErrorCode(err, "ENOENT")) {
      return errorResponse(
        c,
        "DestNotFound",
        "Destination directory does not exist",
        400,
      )
    }
    throw err
  }

  if (sourceStat.isDirectory()) {
    const resolvedSource = path.resolve(sourcePath)
    const resolvedDest = path.resolve(destinationDirPath)
    if (
      resolvedDest === resolvedSource ||
      resolvedDest.startsWith(`${resolvedSource}${path.sep}`)
    ) {
      return errorResponse(
        c,
        "InvalidDestination",
        "Cannot move a directory into itself",
        400,
      )
    }
  }

  const basename = path.basename(normalizedSource)
  const finalDestinationRelative = normalizedDestination
    ? `${normalizedDestination}/${basename}`
    : basename
  const finalDestinationPath = path.join(baseDir, finalDestinationRelative)

  const sourceParent = normalizeRelativePath(path.dirname(normalizedSource))

  if (path.resolve(sourcePath) === path.resolve(finalDestinationPath)) {
    return renderFileListResponse(c, baseDir, sourceParent)
  }

  try {
    await fsStat(finalDestinationPath)
    return alreadyExistsResponse(c, basename)
  } catch (err: unknown) {
    if (!isNodeErrorCode(err, "ENOENT")) {
      throw err
    }
  }

  try {
    await movePath(sourcePath, finalDestinationPath)
  } catch (err: unknown) {
    const failure = mapMovePathError(err)
    if (failure) {
      return errorResponse(c, failure.name, failure.message, failure.status)
    }
    throw err
  }

  return renderFileListResponse(c, baseDir, sourceParent)
}

export async function movePickerHandler(c: Context<AppBindings>) {
  const sourceParam = c.req.query("source") ?? ""
  const destParam = c.req.query("dest")
  const baseDir = getUploadDir(c)
  const user = getUser(c)

  if (!sourceParam || isPathTraversal(sourceParam)) {
    return errorResponse(c, "PathError", "Invalid source", 400)
  }
  // Why not use isPathTraversal here: `..` is the only segment that escapes the
  // picker root, and checking it before the source permission keeps a traversal
  // destination reported as PathError instead of Forbidden. The full check runs
  // on the normalized destination below.
  if (destParam !== undefined && containsParentSegment(destParam)) {
    return errorResponse(c, "PathError", "Invalid destination", 400)
  }

  const normalizedSource = normalizeRelativePath(sourceParam)
  if (!normalizedSource) {
    return errorResponse(c, "PathError", "Invalid source", 400)
  }

  if (!requireWritePermission(user, normalizedSource)) {
    return forbiddenResponse(c)
  }

  const scope = getMoveScope(normalizedSource)
  if (!scope) {
    return errorResponse(c, "PathError", "Invalid source scope", 400)
  }

  const roots = getMovePickerRoots(user, normalizedSource)
  const fallbackRoot = roots[0]

  let currentDest: string
  if (destParam === undefined) {
    const sourceParent = normalizeRelativePath(path.dirname(normalizedSource))
    currentDest = sourceParent || fallbackRoot
  } else {
    const normalized = normalizeRelativePath(destParam)
    currentDest = normalized || fallbackRoot
  }

  if (isPathTraversal(currentDest)) {
    return errorResponse(c, "PathError", "Invalid destination", 400)
  }

  const pickerRoot =
    roots.find((root) => isWithinVirtualPath(root, currentDest)) ?? fallbackRoot
  if (!isWithinVirtualPath(pickerRoot, currentDest)) {
    currentDest = pickerRoot
  }

  const resolved = resolveVirtualPath(baseDir, user, currentDest)
  if (resolved.kind !== "resolved") {
    return errorResponse(c, "PathError", "Cannot resolve destination", 400)
  }

  try {
    const entries = await getFileList(resolved.resolvedPath)
    const directories = entries
      .filter((entry) => entry.type === "dir")
      .map(({ mtime: _m, size: _s, ...rest }) => rest)
    return c.html(
      <MovePickerModal
        source={normalizedSource}
        sourceName={path.basename(normalizedSource)}
        currentDest={currentDest}
        pickerRoot={pickerRoot}
        roots={roots}
        directories={directories}
      />,
    )
  } catch (err: unknown) {
    if (isNodeErrorCode(err, "ENOENT")) {
      return errorResponse(c, "DestNotFound", "Destination does not exist", 400)
    }
    throw err
  }
}
