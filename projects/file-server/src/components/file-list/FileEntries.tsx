import { UploadIcon } from "../icons/UploadIcon"
import {
  dropZoneDragLeaveScript,
  dropZoneDragOverScript,
  dropZoneDropScript,
  openUploadDialogScript,
} from "./clientActions"
import { FileRow } from "./FileRow"
import type { BrowseEntry } from "./types"

interface FileEntriesProps {
  files: BrowseEntry[]
  canUpload: boolean
}

export function FileEntries({ files, canUpload }: FileEntriesProps) {
  const emptyStateClassName = canUpload
    ? "py-12 px-4 text-center text-gray-500 cursor-pointer hover:text-indigo-600 transition-colors"
    : "py-12 px-4 text-center text-gray-500"

  return (
    <div
      id="file-drop-zone"
      className="border-2 border-dashed border-transparent rounded-xl transition-all duration-200"
      hx-on:dragover={canUpload ? dropZoneDragOverScript : undefined}
      hx-on:dragleave={canUpload ? dropZoneDragLeaveScript : undefined}
      hx-on:drop={canUpload ? dropZoneDropScript : undefined}
    >
      {files.length === 0 ? (
        <div
          className={emptyStateClassName}
          hx-on:click={canUpload ? openUploadDialogScript : undefined}
        >
          <UploadIcon />
          <p className="mt-2">
            {canUpload
              ? "Drop files here to upload"
              : "This directory is empty."}
          </p>
        </div>
      ) : (
        <ul className="list-none p-0">
          {files.map((file) => (
            <FileRow key={file.path} file={file} />
          ))}
        </ul>
      )}
      {canUpload && (
        <div
          className="py-4 text-center text-gray-400 text-sm opacity-0 hover:opacity-100 transition-opacity cursor-pointer hover:text-indigo-600"
          hx-on:click={openUploadDialogScript}
        >
          <p>Drag and drop files here to upload</p>
        </div>
      )}
    </div>
  )
}
