import type { FC } from "hono/jsx"
import { ActionBar } from "./file-list/ActionBar"
import { Breadcrumbs } from "./file-list/Breadcrumbs"
import { CreateEntryForms } from "./file-list/CreateEntryForms"
import { DropUploadForm } from "./file-list/DropUploadForm"
import { FileEntries } from "./file-list/FileEntries"
import type { BrowseViewModel } from "./file-list/types"

interface FileListProps {
  view: BrowseViewModel
}

export type { FileItem } from "./file-list/types"

export const FileList: FC<FileListProps> = ({ view }) => {
  return (
    <div id="file-list-container">
      <Breadcrumbs breadcrumbs={view.breadcrumbs} />
      <ActionBar canCreate={view.canCreate} archivePath={view.archivePath} />
      <CreateEntryForms folderPath={view.actionPath} />
      <DropUploadForm requestPath={view.actionPath} />
      <FileEntries files={view.entries} canUpload={view.canUpload} />
    </div>
  )
}
