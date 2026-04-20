import { stat as fsStat } from "node:fs/promises"
import * as path from "node:path"
import type {
  BrowseCrumb,
  BrowseEntry,
  BrowseViewModel,
  FileItem,
} from "../components/file-list/types"
import type { UserState } from "../types"
import { getUserHomeVirtualPath, isUserHomeVirtualPath } from "./auth"
import { getFileList } from "./fileListing"
import { isNodeErrorCode } from "./requestUtils"
import { requireWritePermission, resolveVirtualPath } from "./virtualPath"

type BrowseViewResult =
  | { kind: "forbidden" }
  | { kind: "notFound" }
  | { kind: "file" }
  | { kind: "view"; view: BrowseViewModel }

function joinVirtualPath(basePath: string, name: string): string {
  return basePath ? `${basePath}/${name}` : name
}

function buildStandardBreadcrumbs(
  rootLabel: string,
  requestPath: string,
): BrowseCrumb[] {
  const parts = requestPath.split("/").filter(Boolean)
  const crumbs: BrowseCrumb[] = [{ label: rootLabel, path: "" }]
  let acc = ""

  for (const part of parts) {
    acc = joinVirtualPath(acc, part)
    crumbs.push({ label: part, path: acc })
  }

  return crumbs
}

function buildUserBreadcrumbs(
  user: UserState,
  requestPath: string,
): BrowseCrumb[] {
  const homePath = getUserHomeVirtualPath(user)
  if (!homePath) {
    return buildStandardBreadcrumbs("root", requestPath)
  }

  if (isUserHomeVirtualPath(user, requestPath)) {
    return [{ label: "home", path: "" }]
  }

  if (requestPath === "public" || requestPath.startsWith("public/")) {
    return buildStandardBreadcrumbs("home", requestPath)
  }

  if (requestPath.startsWith(`${homePath}/`)) {
    const relativeParts = requestPath
      .slice(homePath.length + 1)
      .split("/")
      .filter(Boolean)
    const crumbs: BrowseCrumb[] = [{ label: "home", path: "" }]
    let acc = homePath

    for (const part of relativeParts) {
      acc = joinVirtualPath(acc, part)
      crumbs.push({ label: part, path: acc })
    }

    return crumbs
  }

  return buildStandardBreadcrumbs("root", requestPath)
}

function buildBreadcrumbs(user: UserState, requestPath: string): BrowseCrumb[] {
  if (user.type === "authenticated" && user.role === "user") {
    return buildUserBreadcrumbs(user, requestPath)
  }

  return buildStandardBreadcrumbs("root", requestPath)
}

function toBrowseEntry(
  file: FileItem,
  entryPath: string,
  user: UserState,
  options?: {
    canRename?: boolean
    canDelete?: boolean
    canMove?: boolean
    badge?: string
  },
): BrowseEntry {
  return {
    ...file,
    path: entryPath,
    canRename: options?.canRename ?? requireWritePermission(user, entryPath),
    canDelete: options?.canDelete ?? requireWritePermission(user, entryPath),
    canMove: options?.canMove ?? requireWritePermission(user, entryPath),
    badge: options?.badge,
  }
}

async function buildUserHomeView(
  baseDir: string,
  user: UserState,
  homePath: string,
): Promise<BrowseViewModel> {
  const homeEntries = await getFileList(path.join(baseDir, homePath))
  const entries: BrowseEntry[] = [
    toBrowseEntry({ name: "public", type: "dir" }, "public", user, {
      canRename: false,
      canDelete: false,
      canMove: false,
      badge: "Shared",
    }),
    ...homeEntries.map((entry) =>
      toBrowseEntry(entry, joinVirtualPath(homePath, entry.name), user),
    ),
  ]

  return {
    breadcrumbs: [{ label: "home", path: "" }],
    entries,
    actionPath: homePath,
    archivePath: homePath,
    canCreate: true,
    canUpload: true,
  }
}

function buildSyntheticView(
  user: UserState,
  requestPath: string,
  entries: FileItem[],
): BrowseViewModel {
  return {
    breadcrumbs: buildBreadcrumbs(user, requestPath),
    entries: entries.map((entry) =>
      toBrowseEntry(entry, joinVirtualPath(requestPath, entry.name), user, {
        canRename: false,
        canDelete: false,
        canMove: false,
      }),
    ),
    canCreate: false,
    canUpload: false,
  }
}

async function buildResolvedDirectoryView(
  baseDir: string,
  user: UserState,
  requestPath: string,
): Promise<BrowseViewResult> {
  const result = resolveVirtualPath(baseDir, user, requestPath)
  if (result.kind === "forbidden") {
    return { kind: "forbidden" }
  }
  if (result.kind === "notFound") {
    return { kind: "notFound" }
  }
  if (result.kind === "synthetic") {
    return {
      kind: "view",
      view: buildSyntheticView(user, requestPath, result.entries),
    }
  }

  try {
    const statResult = await fsStat(result.resolvedPath)
    if (statResult.isFile()) {
      return { kind: "file" }
    }

    const files = await getFileList(result.resolvedPath)
    return {
      kind: "view",
      view: {
        breadcrumbs: buildBreadcrumbs(user, requestPath),
        entries: files.map((entry) =>
          toBrowseEntry(entry, joinVirtualPath(requestPath, entry.name), user),
        ),
        actionPath: requireWritePermission(user, requestPath)
          ? requestPath
          : undefined,
        archivePath: requestPath,
        canCreate: requireWritePermission(user, requestPath),
        canUpload: requireWritePermission(user, requestPath),
      },
    }
  } catch (error: unknown) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return { kind: "notFound" }
    }
    throw error
  }
}

export async function resolveBrowseView(
  baseDir: string,
  user: UserState,
  requestPath: string,
): Promise<BrowseViewResult> {
  const homePath = getUserHomeVirtualPath(user)
  if (homePath && isUserHomeVirtualPath(user, requestPath)) {
    return {
      kind: "view",
      view: await buildUserHomeView(baseDir, user, homePath),
    }
  }

  return buildResolvedDirectoryView(baseDir, user, requestPath)
}
