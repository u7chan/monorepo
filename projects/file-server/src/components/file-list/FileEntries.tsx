import { UploadIcon } from "../icons/UploadIcon"
import {
  dropZoneDragLeaveScript,
  dropZoneDragOverScript,
  dropZoneDropScript,
  openUploadDialogScript,
} from "./clientActions"
import { FileRow } from "./FileRow"
import type { FileItem } from "./types"

interface FileEntriesProps {
  files: FileItem[]
  requestPath: string
}

export function FileEntries({ files, requestPath }: FileEntriesProps) {
  return (
    <div
      id="file-drop-zone"
      className="border-2 border-dashed border-transparent rounded-xl transition-all duration-200"
      hx-on:dragover={dropZoneDragOverScript}
      hx-on:dragleave={dropZoneDragLeaveScript}
      hx-on:drop={dropZoneDropScript}
    >
      {files.length === 0 ? (
        <div
          className="py-12 px-4 text-center text-gray-500 cursor-pointer hover:text-indigo-600 transition-colors"
          hx-on:click={openUploadDialogScript}
        >
          <UploadIcon />
          <p className="mt-2">Drop files here to upload</p>
        </div>
      ) : (
        <ul className="list-none p-0">
          {files.map((file) => (
            <FileRow key={file.name} file={file} requestPath={requestPath} />
          ))}
        </ul>
      )}
      <div
        className="py-4 text-center text-gray-400 text-sm opacity-0 hover:opacity-100 transition-opacity cursor-pointer hover:text-indigo-600"
        hx-on:click={openUploadDialogScript}
      >
        <p>Drag and drop files here to upload</p>
      </div>
    </div>
  )
}
