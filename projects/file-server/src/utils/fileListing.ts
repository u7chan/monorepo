import { mkdir, readdir, stat as fsStat } from "node:fs/promises"
import * as path from "node:path"
import type { FileItem } from "../components/FileList"

export async function ensureUploadDirExists(uploadDir: string): Promise<void> {
	await mkdir(uploadDir, { recursive: true })
}

export async function getFileList(
	uploadDir: string,
	requestPath: string,
): Promise<FileItem[]> {
	await ensureUploadDirExists(uploadDir)

	const resolvedDir = path.join(uploadDir, requestPath)
	const dirents = await readdir(resolvedDir, { withFileTypes: true })
	return await Promise.all(
		dirents.map(async (ent) => {
			const stat = await fsStat(path.join(resolvedDir, ent.name))
			if (ent.isDirectory()) {
				return { name: ent.name, type: "dir" as const, mtime: stat.mtime }
			}
			return {
				name: ent.name,
				type: "file" as const,
				size: stat.size,
				mtime: stat.mtime,
			}
		}),
	)
}
