import { Hono } from "hono"
import { FileList } from "../components/FileList"
import type { FileItem } from "../components/file-list/types"
import type { AppBindings, UserState } from "../types"
import { getFileList } from "../utils/fileListing"
import {
	errorResponse,
	getRequestPath,
	getUploadDir,
	renderWithShell,
	statOrNotFound,
} from "../utils/requestUtils"
import { resolveVirtualPath } from "../utils/virtualPath"

const browseRoutes = new Hono<AppBindings>()

type BrowseResolution =
	| { kind: "forbidden" }
	| { kind: "notFound" }
	| { kind: "synthetic"; entries: FileItem[] }
	| { kind: "resolved"; resolvedPath: string }

function resolveBrowse(
	baseDir: string,
	user: UserState,
	virtualPath: string,
): BrowseResolution {
	const result = resolveVirtualPath(baseDir, user, virtualPath)
	if (result.kind === "forbidden") return { kind: "forbidden" }
	if (result.kind === "notFound") return { kind: "notFound" }
	if (result.kind === "synthetic")
		return { kind: "synthetic", entries: result.entries }
	return { kind: "resolved", resolvedPath: result.resolvedPath }
}

browseRoutes.get("/", async (c) => {
	const baseDir = getUploadDir(c)
	const requestPath = getRequestPath(c)
	const user = c.get("user") ?? { type: "anonymous" as const }

	const resolved = resolveBrowse(baseDir, user, requestPath)

	if (resolved.kind === "forbidden") {
		return errorResponse(c, "Forbidden", "Access denied", 403)
	}
	if (resolved.kind === "notFound") {
		return errorResponse(c, "NotFound", "File or directory does not exist", 400)
	}
	if (resolved.kind === "synthetic") {
		return renderWithShell(
			c,
			<FileList files={resolved.entries} requestPath={requestPath} />,
		)
	}

	const statOrResponse = await statOrNotFound(
		c,
		resolved.resolvedPath,
		"NotFound",
		"File or directory does not exist",
	)
	if (statOrResponse instanceof Response) {
		return statOrResponse
	}

	if (statOrResponse.isFile()) {
		return c.redirect(`/file?path=${encodeURIComponent(requestPath)}`)
	}

	const files = await getFileList(resolved.resolvedPath)
	return renderWithShell(
		c,
		<FileList files={files} requestPath={requestPath} />,
	)
})

browseRoutes.get("/browse", async (c) => {
	const baseDir = getUploadDir(c)
	const requestPath = getRequestPath(c)
	const user = c.get("user") ?? { type: "anonymous" as const }

	const resolved = resolveBrowse(baseDir, user, requestPath)

	if (resolved.kind === "forbidden") {
		return errorResponse(c, "Forbidden", "Access denied", 403)
	}
	if (resolved.kind === "notFound") {
		return errorResponse(c, "NotFound", "Directory does not exist", 400)
	}
	if (resolved.kind === "synthetic") {
		return c.html(
			<FileList files={resolved.entries} requestPath={requestPath} />,
		)
	}

	const statOrResponse = await statOrNotFound(
		c,
		resolved.resolvedPath,
		"NotFound",
		"Directory does not exist",
	)
	if (statOrResponse instanceof Response) {
		return statOrResponse
	}

	if (!statOrResponse.isDirectory()) {
		return errorResponse(c, "NotADirectory", "Not a directory", 400)
	}

	const files = await getFileList(resolved.resolvedPath)
	return c.html(<FileList files={files} requestPath={requestPath} />)
})

export default browseRoutes
