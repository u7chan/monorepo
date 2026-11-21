import type { Child, FC } from "hono/jsx"
import {
  dismissIconButtonClassName,
  secondaryIconButtonClassName,
} from "../buttonStyles"
import { CloseIcon } from "../icons/CloseIcon"
import { CopyIcon } from "../icons/CopyIcon"
import { DownloadIcon } from "../icons/DownloadIcon"
import { EditIcon } from "../icons/EditIcon"
import { ExternalLinkIcon } from "../icons/ExternalLinkIcon"
import { PreviewIcon } from "../icons/PreviewIcon"
import { modalSurfaceClassName, verticalDividerClassName } from "../uiStyles"
import {
  closeViewerScript,
  copyFileContentScript,
  lockBodyScrollScript,
} from "./clientActions"

interface FileViewerModalProps {
  fileName?: string
  path?: string
  publicUrl?: string
  previewUrl?: string
  isEditing?: boolean
  showEdit?: boolean
  showCopy?: boolean
  layout?: "default" | "pdf"
  children: Child
}

export const FileViewerModal: FC<FileViewerModalProps> = ({
  fileName,
  path,
  publicUrl,
  previewUrl,
  isEditing = false,
  showEdit = false,
  showCopy = false,
  layout = "default",
  children,
}) => {
  const encodedPath = path ? encodeURIComponent(path) : ""

  const downloadButton = path ? (
    <a
      href={`/file/download?path=${encodedPath}`}
      download={fileName || true}
      title="Download"
      aria-label="Download"
      className={secondaryIconButtonClassName}
    >
      <DownloadIcon />
    </a>
  ) : null

  const previewButton = previewUrl ? (
    <a
      href={previewUrl}
      target="_blank"
      rel="noopener noreferrer"
      title="Preview"
      aria-label="Preview"
      className={secondaryIconButtonClassName}
    >
      <PreviewIcon />
    </a>
  ) : null

  const publicUrlButton = publicUrl ? (
    <a
      href={publicUrl}
      target="_blank"
      rel="noopener noreferrer"
      title="Open public URL"
      aria-label="Open public URL"
      className={secondaryIconButtonClassName}
    >
      <ExternalLinkIcon />
    </a>
  ) : null

  const editButton =
    path && !isEditing && showEdit ? (
      <button
        type="button"
        title="Edit"
        aria-label="Edit"
        hx-get={`/file?path=${encodedPath}&edit=true`}
        hx-target="#file-viewer-container"
        hx-swap="outerHTML"
        className={secondaryIconButtonClassName}
      >
        <EditIcon />
      </button>
    ) : null

  const copyButton = showCopy ? (
    <button
      type="button"
      id="file-viewer-copy-button"
      title="Copy all"
      aria-label="Copy all"
      onclick="copyFileContent()"
      className={secondaryIconButtonClassName}
    >
      <CopyIcon />
    </button>
  ) : null

  const closeButton = (
    <button
      type="button"
      title="Close"
      aria-label="Close"
      hx-on:click={closeViewerScript}
      className={dismissIconButtonClassName}
    >
      <CloseIcon />
    </button>
  )

  const hasToolbarActions = Boolean(
    downloadButton ||
      previewButton ||
      publicUrlButton ||
      copyButton ||
      editButton,
  )

  const panelClassName =
    layout === "pdf"
      ? `${modalSurfaceClassName} modal-enter flex h-[92vh] max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden`
      : `${modalSurfaceClassName} modal-enter flex max-h-[80vh] w-full max-w-4xl flex-col overflow-hidden`

  return (
    <div id="file-viewer-container">
      <script dangerouslySetInnerHTML={{ __html: lockBodyScrollScript }} />
      {showCopy ? (
        <script dangerouslySetInnerHTML={{ __html: copyFileContentScript }} />
      ) : null}
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
        hx-on:click={closeViewerScript}
      >
        <div className={panelClassName} hx-on:click="event.stopPropagation();">
          <div className="flex flex-shrink-0 items-center gap-3 border-b border-slate-200 px-5 py-3">
            <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-slate-900">
              {fileName}
            </h2>
            {/* Why not `gap-1`: it leaves 4px between the rings, less than the
                8px inset around each 16px icon, so the group reads as one
                cramped strip. */}
            <div className="flex shrink-0 items-center gap-2">
              {downloadButton}
              {previewButton}
              {publicUrlButton}
              {copyButton}
              {editButton}
              {/* Actions and dismissal are different roles: keep one hairline
                  between them instead of relying on tone alone. */}
              {hasToolbarActions && (
                <span
                  aria-hidden="true"
                  className={`${verticalDividerClassName} mx-1`}
                />
              )}
              {closeButton}
            </div>
          </div>
          <div
            className={
              layout === "pdf"
                ? "flex min-h-0 flex-1 flex-col p-4"
                : "flex min-h-0 flex-1 flex-col p-5"
            }
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
