import { toggleButtonIdleClassName } from "../buttonStyles"
import { DownloadIcon } from "../icons/DownloadIcon"
import { FileIcon } from "../icons/FileIcon"
import { FolderIcon } from "../icons/FolderIcon"
import { toggleCreateFormScript } from "./clientActions"

interface ActionBarProps {
  canCreate: boolean
  archivePath?: string
}

export function ActionBar({ canCreate, archivePath }: ActionBarProps) {
  if (!canCreate && !archivePath) {
    return null
  }

  const archiveHref = archivePath
    ? `/file/archive?path=${encodeURIComponent(archivePath)}`
    : null

  return (
    <div className="mb-4 grid grid-cols-2 gap-3 sm:flex">
      {canCreate && (
        <button
          id="new-file-button"
          type="button"
          className={toggleButtonIdleClassName}
          hx-on:click={toggleCreateFormScript(
            "new-file-form",
            "new-folder-form",
            "new-folder-button",
          )}
        >
          <FileIcon />
          New File
        </button>
      )}
      {canCreate && (
        <button
          id="new-folder-button"
          type="button"
          className={toggleButtonIdleClassName}
          hx-on:click={toggleCreateFormScript(
            "new-folder-form",
            "new-file-form",
            "new-file-button",
          )}
        >
          <FolderIcon />
          New Folder
        </button>
      )}
      {archiveHref && (
        <a
          href={archiveHref}
          className={`${toggleButtonIdleClassName} col-span-2 no-underline sm:col-span-1`}
        >
          <DownloadIcon />
          Download Zip
        </a>
      )}
    </div>
  )
}
