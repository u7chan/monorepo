import { stat as fsStat, mkdir, readdir } from "node:fs/promises"
import * as path from "node:path"
import type { FileItem } from "../components/file-list/types"
import { sortFiles } from "./fileUtils"

export async function ensureUploadDirExists(uploadDir: string): Promise<void> {
	await mkdir(uploadDir, { recursive: true })
}

export async function getFileList(resolvedDir: string): Promise<FileItem[]> {
	const dirents = await readdir(resolvedDir, { withFileTypes: true })
	return sortFiles(
		await Promise.all(
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
		),
	)
}
