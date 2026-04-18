import type { Context } from "hono"
import { FileList } from "../components/FileList"
import type { AppBindings } from "../types"
import { toBrowseLocation } from "./auth"
import { resolveBrowseView } from "./browseContext"
import { errorResponse, isHtmxRequest } from "./requestUtils"

export async function renderFileListResponse(
  c: Context<AppBindings>,
  baseDir: string,
  virtualPath: string,
  options?: {
    redirectPath?: string
    encodeRedirectPath?: boolean
  },
) {
  const user = c.get("user") ?? { type: "anonymous" as const }
  const browsePath = toBrowseLocation(user, virtualPath)
  const result = await resolveBrowseView(baseDir, user, browsePath)

  if (result.kind !== "view") {
    return errorResponse(c, "Forbidden", "Access denied", 403)
  }

  if (isHtmxRequest(c)) {
    return c.html(<FileList view={result.view} />)
  }

  const redirectPath = toBrowseLocation(
    user,
    options?.redirectPath ?? virtualPath,
  )
  if (redirectPath === "") {
    return c.redirect("/", 301)
  }
  const encodedPath =
    options?.encodeRedirectPath === false
      ? redirectPath
      : encodeURIComponent(redirectPath)
  return c.redirect(`/?path=${encodedPath}`, 301)
}

export function alreadyExistsResponse(c: Context<AppBindings>, name: string) {
  return errorResponse(c, "AlreadyExists", `"${name}" already exists.`, 400)
}
