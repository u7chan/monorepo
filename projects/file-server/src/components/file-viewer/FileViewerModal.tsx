import type { Child, FC } from "hono/jsx"
import {
  dismissIconButtonClassName,
  secondaryIconButtonClassName,
} from "../buttonStyles"
import { CloseIcon } from "../icons/CloseIcon"
import { DownloadIcon } from "../icons/DownloadIcon"
import { EditIcon } from "../icons/EditIcon"
import { ExternalLinkIcon } from "../icons/ExternalLinkIcon"

interface FileViewerModalProps {
  fileName?: string
  path?: string
  publicUrl?: string
  borderColor?: string
  animation?: string
  isEditing?: boolean
  showEdit?: boolean
  layout?: "default" | "pdf"
  children: Child
}

export const FileViewerModal: FC<FileViewerModalProps> = ({
  fileName,
  path,
  publicUrl,
  borderColor = "indigo-300",
  animation,
  isEditing = false,
  showEdit = false,
  layout = "default",
  children,
}) => {
  const encodedPath = path ? encodeURIComponent(path) : ""
  const closeScript =
    "document.getElementById('file-viewer-container').innerHTML = ''; document.body.style.overflow = 'auto'; history.pushState(null, '', '/');"

  const downloadButton = path ? (
    <a
      href={`/file/download?path=${encodedPath}`}
      download={fileName || true}
      className={secondaryIconButtonClassName}
    >
      <DownloadIcon />
    </a>
  ) : null

  const publicUrlButton = publicUrl ? (
    <a
      href={publicUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={secondaryIconButtonClassName}
    >
      <ExternalLinkIcon />
    </a>
  ) : null

  const editButton =
    path && !isEditing && showEdit ? (
      <button
        type="button"
        hx-get={`/file?path=${encodedPath}&edit=true`}
        hx-target="#file-viewer-container"
        hx-swap="outerHTML"
        className={secondaryIconButtonClassName}
      >
        <EditIcon />
      </button>
    ) : null

  const closeButton = (
    <button
      type="button"
      hx-on:click={closeScript}
      className={dismissIconButtonClassName}
    >
      <CloseIcon />
    </button>
  )

  const panelClassName =
    layout === "pdf"
      ? `bg-white p-4 sm:p-6 rounded-[1.5rem] w-full max-w-6xl h-[92vh] max-h-[92vh] overflow-hidden flex flex-col border-4 border-${borderColor} ${animation || ""}`
      : `bg-white p-6 rounded-2xl max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col border-4 border-${borderColor} ${animation || ""}`

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
        <div className={panelClassName} hx-on:click="event.stopPropagation();">
          <div className="flex justify-between items-center mb-4 pb-4 border-b-2 border-indigo-200 flex-shrink-0">
            <h2 className="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent truncate max-w-[70%]">
              {fileName}
            </h2>
            <div className="flex items-center gap-2">
              {downloadButton}
              {publicUrlButton}
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
