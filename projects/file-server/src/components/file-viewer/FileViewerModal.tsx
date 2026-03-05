import type { Child, FC } from "hono/jsx"
import { CloseIcon } from "../icons/CloseIcon"
import { DownloadIcon } from "../icons/DownloadIcon"
import { EditIcon } from "../icons/EditIcon"

interface FileViewerModalProps {
  fileName?: string
  path?: string
  borderColor?: string
  animation?: string
  isEditing?: boolean
  showEdit?: boolean
  children: Child
}

export const FileViewerModal: FC<FileViewerModalProps> = ({
  fileName,
  path,
  borderColor = "indigo-300",
  animation,
  isEditing = false,
  showEdit = false,
  children,
}) => {
  const encodedPath = path ? encodeURIComponent(path) : ""
  const closeScript =
    "document.getElementById('file-viewer-container').innerHTML = ''; document.body.style.overflow = 'auto'; history.pushState(null, '', '/');"

  const downloadButton = path ? (
    <a
      href={`/file/raw?path=${encodedPath}`}
      download={fileName || true}
      className="w-12 h-10 bg-gradient-to-r from-indigo-500 to-purple-500 text-white font-bold text-base border-none rounded-xl cursor-pointer hover:from-indigo-600 hover:to-purple-600 transition-all transform hover:scale-110 hover:shadow-xl shadow-md inline-flex items-center justify-center"
    >
      <DownloadIcon />
    </a>
  ) : null

  const editButton =
    path && !isEditing && showEdit ? (
      <button
        type="button"
        hx-get={`/file?path=${encodedPath}&edit=true`}
        hx-target="#file-viewer-container"
        hx-swap="outerHTML"
        className="w-12 h-10 bg-gradient-to-r from-emerald-500 to-teal-500 text-white font-bold text-base border-none rounded-xl cursor-pointer hover:from-emerald-600 hover:to-teal-600 transition-all transform hover:scale-110 hover:shadow-xl shadow-md inline-flex items-center justify-center"
      >
        <EditIcon />
      </button>
    ) : null

  const closeButton = (
    <button
      type="button"
      hx-on:click={closeScript}
      className="w-12 h-10 bg-gradient-to-r from-rose-500 to-pink-500 text-white font-bold text-base border-none rounded-xl cursor-pointer hover:from-rose-600 hover:to-pink-600 transition-all transform hover:scale-110 hover:shadow-xl shadow-md inline-flex items-center justify-center"
    >
      <CloseIcon />
    </button>
  )

  return (
    <div id="file-viewer-container">
      <script
        dangerouslySetInnerHTML={{
          __html: "document.body.style.overflow = 'hidden';",
        }}
      />
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50"
        hx-on:click={closeScript}
      >
        <div
          className={`bg-white p-6 rounded-2xl max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col border-4 border-${borderColor} ${animation || ""}`}
          hx-on:click="event.stopPropagation();"
        >
          <div className="flex justify-between items-center mb-4 pb-4 border-b-2 border-indigo-200 flex-shrink-0">
            <h2 className="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent truncate max-w-[70%]">
              {fileName}
            </h2>
            <div className="flex items-center gap-2">
              {downloadButton}
              {editButton}
              {closeButton}
            </div>
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}
