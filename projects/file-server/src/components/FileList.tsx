import type { FC } from "hono/jsx"
import { sortFiles } from "../utils/fileUtils"
import { ActionBar } from "./file-list/ActionBar"
import { Breadcrumbs } from "./file-list/Breadcrumbs"
import { CreateEntryForms } from "./file-list/CreateEntryForms"
import { DropUploadForm } from "./file-list/DropUploadForm"
import { FileEntries } from "./file-list/FileEntries"
import type { FileItem } from "./file-list/types"

interface FileListProps {
	files: FileItem[]
	requestPath: string
}

export type { FileItem } from "./file-list/types"

export const FileList: FC<FileListProps> = ({ files, requestPath }) => {
	const sortedFiles = sortFiles(files)
	const folderPath = requestPath
		? requestPath + (requestPath.endsWith("/") ? "" : "/")
		: ""
	const archiveHref = `/file/archive?path=${encodeURIComponent(requestPath)}`

	return (
		<div id="file-list-container">
			<Breadcrumbs requestPath={requestPath} />
			<ActionBar archiveHref={archiveHref} />
			<CreateEntryForms folderPath={folderPath} />
			<DropUploadForm requestPath={requestPath} />
			<FileEntries files={sortedFiles} requestPath={requestPath} />
		</div>
	)
}
