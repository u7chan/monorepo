import { toggleButtonIdleClassName } from "../buttonStyles"
import { DownloadIcon } from "../icons/DownloadIcon"
import { FileIcon } from "../icons/FileIcon"
import { FolderIcon } from "../icons/FolderIcon"
import { toggleCreateFormScript } from "./clientActions"

interface ActionBarProps {
  archiveHref: string
}

export function ActionBar({ archiveHref }: ActionBarProps) {
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 sm:flex">
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
      <a
        href={archiveHref}
        className={`${toggleButtonIdleClassName} col-span-2 no-underline sm:col-span-1`}
      >
        <DownloadIcon />
        Download Zip
      </a>
    </div>
  )
}
