import * as path from "node:path"
import { formatFileSize, formatTimestamp } from "../../utils/formatters"
import {
	dangerIconButtonClassName,
	dismissButtonClassName,
	primaryButtonClassName,
	secondaryButtonClassName,
} from "../buttonStyles"
import { DeleteIcon } from "../icons/DeleteIcon"
import { EditIcon } from "../icons/EditIcon"
import { FileIcon } from "../icons/FileIcon"
import { FolderIcon } from "../icons/FolderIcon"
import {
	closeRenameFormScript,
	renameButtonScript,
	stopPropagationScript,
} from "./clientActions"
import { FormErrorMessage } from "./FormErrorMessage"
import type { FileItem } from "./types"

interface FileRowProps {
	file: FileItem
	requestPath: string
}

export function FileRow({ file, requestPath }: FileRowProps) {
	const filePath = path.join(requestPath, file.name)
	const encodedPath = encodeURIComponent(filePath)
	const renameFormId = `rename-form-${encodedPath}`
	const renameInputId = `rename-input-${encodedPath}`

	return (
		<li
			className="py-3 px-4 mb-2 rounded-xl border-2 border-transparent hover:border-indigo-300 hover:bg-gradient-to-r hover:from-indigo-50 hover:to-purple-50 cursor-pointer transition-all duration-200"
			hx-get={
				file.type === "dir"
					? `/browse?path=${encodedPath}`
					: `/file?path=${encodedPath}`
			}
			hx-target={
				file.type === "dir" ? "#file-list-container" : "#file-viewer-container"
			}
			hx-push-url={
				file.type === "dir"
					? `/?path=${encodedPath}`
					: `/file?path=${encodedPath}`
			}
		>
			<div className="flex items-center justify-between gap-3">
				<span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-indigo-700 font-medium transition-colors hover:text-purple-600">
					{file.type === "dir" ? (
						<>
							<span className="flex-shrink-0">
								<FolderIcon />
							</span>
							<span className="break-all min-w-0">{file.name}/</span>
						</>
					) : (
						<>
							<span className="flex-shrink-0">
								<FileIcon />
							</span>
							<span className="break-all min-w-0">{file.name}</span>
						</>
					)}
				</span>

				<div className="flex shrink-0 items-center gap-2 md:gap-4">
					{file.type === "file" && (
						<div className="hidden md:block md:w-30 text-right">
							{formatFileSize(file.size || 0)}
						</div>
					)}
					<div className="hidden md:block md:w-45 text-right text-gray-600 text-sm">
						{file.mtime && formatTimestamp(new Date(file.mtime))}
					</div>
					<div
						className="flex shrink-0 justify-end gap-2"
						hx-on:click={stopPropagationScript}
					>
						<button
							type="button"
							title="Rename"
							aria-label="Rename"
							data-rename-button
							className={`${secondaryButtonClassName} h-8 w-8 px-0 md:w-auto md:px-3`}
							hx-on:click={renameButtonScript(renameFormId, renameInputId)}
						>
							<span className="md:hidden">
								<EditIcon />
							</span>
							<span className="hidden md:flex md:items-center md:gap-2">
								<EditIcon />
								<span>Rename</span>
							</span>
						</button>
						<form
							hx-post="/api/delete"
							hx-target="#file-list-container"
							hx-swap="innerHTML"
							hx-confirm={`Are you sure you want to delete ${file.name}?`}
						>
							<input type="hidden" name="path" value={filePath} />
							<button
								type="submit"
								title="Delete"
								aria-label="Delete"
								className={dangerIconButtonClassName}
							>
								<DeleteIcon />
							</button>
						</form>
					</div>
				</div>
			</div>
			<form
				id={renameFormId}
				data-rename-form
				data-inline-error-form
				hx-post="/api/rename"
				hx-target="#file-list-container"
				hx-swap="innerHTML"
				className="hidden mt-3 pt-3 border-t border-indigo-100"
				hx-on:click={stopPropagationScript}
			>
				<input type="hidden" name="path" value={filePath} />
				<div className="flex flex-col sm:flex-row gap-2">
					<input
						id={renameInputId}
						type="text"
						name="name"
						value={file.name}
						required
						className="px-4 py-2 border-2 border-indigo-300 rounded-lg focus:outline-none focus:border-purple-500 transition-colors"
					/>
					<div className="flex gap-2">
						<button type="submit" className={primaryButtonClassName}>
							Save
						</button>
						<button
							type="button"
							className={dismissButtonClassName}
							hx-on:click={closeRenameFormScript(renameFormId)}
						>
							Cancel
						</button>
					</div>
				</div>
				<FormErrorMessage />
			</form>
		</li>
	)
}
