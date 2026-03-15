import type { Context } from "hono"
import { FileList } from "../components/FileList"
import type { AppBindings } from "../types"
import { getFileList } from "./fileListing"
import {
	errorResponse,
	invalidPathResponse,
	isHtmxRequest,
} from "./requestUtils"

export function isNodeErrorCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: string }).code === code
	)
}

export function validatePathOrError(
	c: Context<AppBindings>,
	requestPath: string,
): Response | null {
	if (requestPath.includes("\0")) {
		return invalidPathResponse(c)
	}
	return null
}

export async function renderFileListResponse(
	c: Context<AppBindings>,
	uploadDir: string,
	requestPath: string,
	options?: {
		redirectPath?: string
		encodeRedirectPath?: boolean
	},
) {
	const files = await getFileList(uploadDir, requestPath)
	if (isHtmxRequest(c)) {
		return c.html(<FileList files={files} requestPath={requestPath} />)
	}

	const redirectPath = options?.redirectPath ?? requestPath
	const encodedPath =
		options?.encodeRedirectPath === false
			? redirectPath
			: encodeURIComponent(redirectPath)
	return c.redirect(`/?path=${encodedPath}`, 301)
}

export function alreadyExistsResponse(
	c: Context<AppBindings>,
	name: string,
) {
	return errorResponse(c, "AlreadyExists", `"${name}" already exists.`, 400)
}
