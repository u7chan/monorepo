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
    ? "py-14 px-4 text-center text-slate-400 cursor-pointer transition-colors hover:text-indigo-600"
    : "py-14 px-4 text-center text-slate-400"

  return (
    <div
      id="file-drop-zone"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-xl bg-white ring-1 ring-slate-200 transition-[box-shadow,background-color] data-[dragging]:bg-indigo-50 data-[dragging]:ring-2 data-[dragging]:ring-indigo-400"
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
        <ul className="list-none divide-y divide-slate-100 p-0">
          {files.map((file) => (
            <FileRow key={file.path} file={file} />
          ))}
        </ul>
      )}
      {canUpload && files.length > 0 && (
        <div
          className="mt-auto cursor-pointer py-4 text-center text-xs text-slate-400 transition-colors hover:text-indigo-600"
          hx-on:click={openUploadDialogScript}
        >
          <p>Drop files here to upload</p>
        </div>
      )}
    </div>
  )
}
