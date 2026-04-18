import type { Context } from "hono"
import { FileList } from "../components/FileList"
import type { AppBindings } from "../types"
import { getFileList } from "./fileListing"
import { errorResponse, isHtmxRequest } from "./requestUtils"
import { resolveVirtualPath } from "./virtualPath"

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
	const result = resolveVirtualPath(baseDir, user, virtualPath)

	let files: Awaited<ReturnType<typeof getFileList>>
	if (result.kind === "synthetic") {
		files = result.entries.map((e) => ({ ...e, mtime: new Date(0) }))
	} else if (result.kind === "resolved") {
		files = await getFileList(result.resolvedPath)
	} else {
		return errorResponse(c, "Forbidden", "Access denied", 403)
	}

	if (isHtmxRequest(c)) {
		return c.html(<FileList files={files} requestPath={virtualPath} />)
	}

	const redirectPath = options?.redirectPath ?? virtualPath
	const encodedPath =
		options?.encodeRedirectPath === false
			? redirectPath
			: encodeURIComponent(redirectPath)
	return c.redirect(`/?path=${encodedPath}`, 301)
}

export function alreadyExistsResponse(c: Context<AppBindings>, name: string) {
	return errorResponse(c, "AlreadyExists", `"${name}" already exists.`, 400)
}
