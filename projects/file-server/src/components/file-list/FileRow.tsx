import { formatFileSize, formatTimestamp } from "../../utils/formatters"
import {
  dangerIconButtonClassName,
  dismissButtonClassName,
  primaryButtonClassName,
  rowActionToggleClassName,
} from "../buttonStyles"
import { DeleteIcon } from "../icons/DeleteIcon"
import { EditIcon } from "../icons/EditIcon"
import { FileIcon } from "../icons/FileIcon"
import { FolderIcon } from "../icons/FolderIcon"
import { MoveIcon } from "../icons/MoveIcon"
import { badgeClassName, fieldClassName } from "../uiStyles"
import {
  closeRenameFormScript,
  renameButtonScript,
  stopPropagationScript,
} from "./clientActions"
import { FormErrorMessage } from "./FormErrorMessage"
import type { BrowseEntry } from "./types"

interface FileRowProps {
  file: BrowseEntry
}

function buildBrowseHref(path: string): string {
  return path ? `/?path=${encodeURIComponent(path)}` : "/"
}

export function FileRow({ file }: FileRowProps) {
  const encodedPath = encodeURIComponent(file.path)
  const renameFormId = `rename-form-${encodedPath}`
  const renameInputId = `rename-input-${encodedPath}`
  const browseHref = buildBrowseHref(file.path)
  const showRowActions = file.canRename || file.canDelete || file.canMove

  return (
    <li
      className="group cursor-pointer transition-colors hover:bg-slate-50"
      hx-get={
        file.type === "dir"
          ? `/browse?path=${encodedPath}`
          : `/file?path=${encodedPath}`
      }
      hx-target={
        file.type === "dir" ? "#file-list-container" : "#file-viewer-container"
      }
      hx-push-url={
        file.type === "dir" ? browseHref : `/file?path=${encodedPath}`
      }
    >
      <div className="flex items-center justify-between gap-3 px-4 py-2.5">
        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden font-medium text-slate-700 group-hover:text-indigo-700">
          <span className="flex-shrink-0 text-slate-400">
            {file.type === "dir" ? <FolderIcon /> : <FileIcon />}
          </span>
          <span className="min-w-0 break-all">
            {file.name}
            {file.type === "dir" ? "/" : ""}
          </span>
          {file.badge && <span className={badgeClassName}>{file.badge}</span>}
        </span>

        <div className="flex shrink-0 items-center gap-2 md:gap-4">
          {file.type === "file" && (
            <div className="hidden text-right text-sm text-slate-400 tabular-nums md:block md:w-24">
              {formatFileSize(file.size || 0)}
            </div>
          )}
          <div className="hidden text-right text-sm text-slate-400 tabular-nums md:block md:w-40">
            {file.mtime && formatTimestamp(new Date(file.mtime))}
          </div>
          {showRowActions && (
            <div
              className="flex shrink-0 items-center justify-end gap-1"
              hx-on:click={stopPropagationScript}
            >
              {file.canMove && (
                <button
                  type="button"
                  title="Move"
                  aria-label="Move"
                  className={rowActionToggleClassName}
                  hx-get={`/api/move/picker?source=${encodedPath}`}
                  hx-target="#move-picker-container"
                  hx-swap="innerHTML"
                >
                  <MoveIcon />
                  <span className="hidden md:inline">Move</span>
                </button>
              )}
              {file.canRename && (
                <button
                  type="button"
                  title="Rename"
                  aria-label="Rename"
                  aria-expanded="false"
                  data-rename-button
                  className={rowActionToggleClassName}
                  hx-on:click={renameButtonScript(renameFormId, renameInputId)}
                >
                  <EditIcon />
                  <span className="hidden md:inline">Rename</span>
                </button>
              )}
              {file.canDelete && (
                <form
                  hx-post="/api/delete"
                  hx-target="#file-list-container"
                  hx-swap="innerHTML"
                  hx-confirm={`Are you sure you want to delete ${file.name}?`}
                >
                  <input type="hidden" name="path" value={file.path} />
                  <button
                    type="submit"
                    title="Delete"
                    aria-label="Delete"
                    className={dangerIconButtonClassName}
                  >
                    <DeleteIcon />
                  </button>
                </form>
              )}
            </div>
          )}
        </div>
      </div>
      {file.canRename && (
        <form
          id={renameFormId}
          data-rename-form
          data-inline-error-form
          hx-post="/api/rename"
          hx-target="#file-list-container"
          hx-swap="innerHTML"
          className="hidden px-4 pb-4"
          hx-on:click={stopPropagationScript}
        >
          <input type="hidden" name="path" value={file.path} />
          <div className="flex flex-col gap-2 border-t border-slate-100 pt-3 sm:flex-row">
            <input
              id={renameInputId}
              type="text"
              name="name"
              value={file.name}
              required
              className={`${fieldClassName} sm:max-w-sm`}
            />
            <div className="flex gap-2">
              <button type="submit" className={primaryButtonClassName}>
                Save
              </button>
              <button
                type="button"
                className={dismissButtonClassName}
                hx-on:click={closeRenameFormScript(renameFormId)}
              >
                Cancel
              </button>
            </div>
          </div>
          <FormErrorMessage />
        </form>
      )}
    </li>
  )
}
