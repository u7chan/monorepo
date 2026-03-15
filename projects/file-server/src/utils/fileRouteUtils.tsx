import { readdir, readFile } from "node:fs/promises"
import * as path from "node:path"
import * as mime from "mime-types"
import type { Context } from "hono"
import type { AppBindings } from "../types"
import { ensureUploadDirExists } from "./fileListing"
import {
	ensureValidPath,
	errorResponse,
	getRequestPath,
	getUploadDir,
	statOrNotFound,
} from "./requestUtils"

const EMPTY_ZIP_ARCHIVE = new Uint8Array([
	0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
])

export const isTextMime = (mimeType: string) =>
	/^text\//.test(mimeType) || /json$|javascript$|xml$/.test(mimeType)

export const isPreviewableBinary = (mimeType: string) =>
	mimeType.startsWith("image/") ||
	mimeType.startsWith("video/") ||
	mimeType === "application/pdf"

export const toArrayBuffer = (contentBuffer: Buffer): ArrayBuffer =>
	contentBuffer.buffer.slice(
		contentBuffer.byteOffset,
		contentBuffer.byteOffset + contentBuffer.byteLength,
	) as ArrayBuffer

export const archiveFileName = (requestPath: string) =>
	requestPath ? `${path.basename(requestPath)}.zip` : "root.zip"

const isZipCommandMissing = (message: string) =>
	message.includes('Executable not found in $PATH: "zip"')

export const archiveErrorMessage = (error: unknown) => {
	const message =
		error instanceof Error ? error.message : "Failed to start zip command"

	if (isZipCommandMissing(message)) {
		return "Zip download is unavailable because the server does not have the zip command installed"
	}

	return message
}

export async function createDirectoryArchive(
	resolvedDir: string,
): Promise<{ body: ArrayBuffer; error: string | null }> {
	const entries = await readdir(resolvedDir)
	if (entries.length === 0) {
		return { body: EMPTY_ZIP_ARCHIVE.buffer.slice(0), error: null }
	}

	let zipProcess: ReturnType<typeof Bun.spawn>
	try {
		zipProcess = Bun.spawn(["zip", "-q", "-r", "-", ...entries], {
			cwd: resolvedDir,
			stdout: "pipe",
			stderr: "pipe",
		})
	} catch (error) {
		return {
			body: EMPTY_ZIP_ARCHIVE.buffer.slice(0),
			error: archiveErrorMessage(error),
		}
	}

	if (
		!(zipProcess.stdout instanceof ReadableStream) ||
		!(zipProcess.stderr instanceof ReadableStream)
	) {
		return {
			body: EMPTY_ZIP_ARCHIVE.buffer.slice(0),
			error: "zip command did not provide readable output streams",
		}
	}

	const [body, stderr, exitCode] = await Promise.all([
		new Response(zipProcess.stdout).arrayBuffer(),
		new Response(zipProcess.stderr).text(),
		zipProcess.exited,
	])

	if (exitCode !== 0) {
		return {
			body,
			error: stderr.trim() || `zip command failed with exit code ${exitCode}`,
		}
	}

	return { body, error: null }
}

export async function resolveRequestedFile(
	c: Context<AppBindings>,
	notFoundMessage: string,
) {
	const uploadDir = getUploadDir(c)
	const requestPath = getRequestPath(c)
	const invalidResponse = ensureValidPath(c, requestPath)
	if (invalidResponse) {
		return { response: invalidResponse }
	}

	await ensureUploadDirExists(uploadDir)
	const resolvedPath = path.join(uploadDir, requestPath)
	const statOrResponse = await statOrNotFound(
		c,
		resolvedPath,
		"NotFound",
		notFoundMessage,
	)
	if (statOrResponse instanceof Response) {
		return { response: statOrResponse }
	}

	return {
		uploadDir,
		requestPath,
		resolvedPath,
		stat: statOrResponse,
		mimeType: mime.lookup(resolvedPath) || "application/octet-stream",
	}
}

export async function readBinaryFileResponse(resolvedPath: string, mimeType: string) {
	const contentBuffer = await readFile(resolvedPath)
	return new Response(toArrayBuffer(contentBuffer), {
		headers: { "Content-Type": mimeType },
	})
}

export function notAFileResponse(c: Context<AppBindings>) {
	return errorResponse(c, "NotAFile", "Not a file", 400)
}

export function notADirectoryResponse(c: Context<AppBindings>) {
	return errorResponse(c, "NotADirectory", "Not a directory", 400)
}
