import type { FC } from "hono/jsx"
import {
  dismissButtonClassName,
  dismissIconButtonClassName,
  primaryButtonClassName,
} from "../buttonStyles"
import { CloseIcon } from "../icons/CloseIcon"
import { FolderIcon } from "../icons/FolderIcon"
import { FormErrorMessage } from "./FormErrorMessage"
import type { FileItem } from "./types"

interface MovePickerModalProps {
  source: string
  sourceName: string
  currentDest: string
  pickerRoot: string
  roots: string[]
  directories: FileItem[]
}

const closePickerScript =
  "document.getElementById('move-picker-container').innerHTML = '';"

interface PickerCrumb {
  label: string
  path: string
}

function buildPickerBreadcrumbs(
  pickerRoot: string,
  currentDest: string,
): PickerCrumb[] {
  const rootParts = pickerRoot.split("/").filter(Boolean)
  const currentParts = currentDest.split("/").filter(Boolean)
  const rootLabel = rootParts[rootParts.length - 1] ?? pickerRoot
  const crumbs: PickerCrumb[] = [{ label: rootLabel, path: pickerRoot }]

  let acc = pickerRoot
  for (let i = rootParts.length; i < currentParts.length; i++) {
    const part = currentParts[i]
    acc = acc ? `${acc}/${part}` : part
    crumbs.push({ label: part, path: acc })
  }

  return crumbs
}

function pickerHref(source: string, dest: string): string {
  return `/api/move/picker?source=${encodeURIComponent(source)}&dest=${encodeURIComponent(dest)}`
}

function isInsideSource(source: string, destination: string): boolean {
  return source === destination || destination.startsWith(`${source}/`)
}

const rootButtonBaseClassName =
  "px-3 py-1 rounded-full border-2 text-sm font-semibold cursor-pointer break-all"

function rootButtonClassName(isActive: boolean): string {
  return isActive
    ? `${rootButtonBaseClassName} border-indigo-500 bg-indigo-500 text-white`
    : `${rootButtonBaseClassName} border-indigo-200 bg-white text-indigo-600 hover:border-indigo-400 hover:bg-indigo-50`
}

export const MovePickerModal: FC<MovePickerModalProps> = ({
  source,
  sourceName,
  currentDest,
  pickerRoot,
  roots,
  directories,
}) => {
  const breadcrumbs = buildPickerBreadcrumbs(pickerRoot, currentDest)
  const sourceParent = source.split("/").slice(0, -1).join("/")
  const isSameAsSourceParent = currentDest === sourceParent
  const isInvalidDestination = isInsideSource(source, currentDest)

  return (
    <div
      data-move-picker-modal
      className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      hx-on:click={closePickerScript}
    >
      <div
        className="bg-white p-6 rounded-2xl max-w-lg w-full max-h-[80vh] overflow-hidden flex flex-col border-4 border-indigo-300"
        hx-on:click="event.stopPropagation();"
      >
        <div className="flex justify-between items-center mb-4 pb-4 border-b-2 border-indigo-200 flex-shrink-0 gap-3">
          <h2 className="text-xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent truncate">
            Move "{sourceName}"
          </h2>
          <button
            type="button"
            aria-label="Close"
            hx-on:click={closePickerScript}
            className={dismissIconButtonClassName}
          >
            <CloseIcon />
          </button>
        </div>

        {roots.length > 1 ? (
          <div
            data-picker-roots
            className="flex flex-wrap gap-2 mb-3 flex-shrink-0"
          >
            {roots.map((root) => {
              const isActive = root === pickerRoot
              return (
                <button
                  key={root}
                  type="button"
                  data-picker-root={root}
                  aria-current={isActive ? "true" : undefined}
                  hx-get={pickerHref(source, root)}
                  hx-target="#move-picker-container"
                  hx-swap="innerHTML"
                  className={rootButtonClassName(isActive)}
                >
                  {root}
                </button>
              )
            })}
          </div>
        ) : null}

        <nav
          data-picker-breadcrumbs
          className="mb-3 p-3 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl border border-indigo-200 text-sm break-all"
        >
          {breadcrumbs.map((crumb, idx) => {
            const isLast = idx === breadcrumbs.length - 1
            return (
              <span key={`${crumb.label}:${crumb.path}`}>
                <button
                  type="button"
                  hx-get={pickerHref(source, crumb.path)}
                  hx-target="#move-picker-container"
                  hx-swap="innerHTML"
                  className="text-indigo-600 font-semibold hover:text-purple-600 mx-1 cursor-pointer"
                >
                  {crumb.label}
                </button>
                {!isLast ? " / " : ""}
              </span>
            )
          })}
        </nav>

        <div
          data-picker-directories
          className="flex-1 min-h-[8rem] overflow-y-auto mb-4 border border-indigo-100 rounded-xl"
        >
          {directories.length === 0 ? (
            <p className="py-8 px-4 text-center text-gray-500">
              No subdirectories here.
            </p>
          ) : (
            <ul className="list-none p-2 m-0">
              {directories.map((dir) => {
                const dirPath = currentDest
                  ? `${currentDest}/${dir.name}`
                  : dir.name
                return (
                  <li
                    key={dir.name}
                    className="py-2 px-3 mb-1 rounded-lg border-2 border-transparent hover:border-indigo-300 hover:bg-indigo-50 cursor-pointer flex items-center gap-2 text-indigo-700 font-medium"
                    hx-get={pickerHref(source, dirPath)}
                    hx-target="#move-picker-container"
                    hx-swap="innerHTML"
                  >
                    <FolderIcon />
                    <span className="break-all">{dir.name}/</span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <form
          hx-post="/api/move"
          hx-target="#file-list-container"
          hx-swap="innerHTML"
          data-inline-error-form
          data-move-form
          className="flex-shrink-0 pt-4 border-t-2 border-indigo-200"
        >
          <input type="hidden" name="path" value={source} />
          <input type="hidden" name="destination" value={currentDest} />
          <p className="mb-3 text-sm text-gray-600 break-all">
            Destination:{" "}
            <span data-picker-destination className="font-mono text-indigo-700">
              {currentDest || "/"}
            </span>
          </p>
          {isInvalidDestination ? (
            <p
              data-picker-invalid-destination
              className="mb-3 text-sm text-red-600"
            >
              Choose a destination outside "{sourceName}".
            </p>
          ) : null}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              className={dismissButtonClassName}
              hx-on:click={closePickerScript}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={primaryButtonClassName}
              disabled={isSameAsSourceParent || isInvalidDestination}
            >
              Move here
            </button>
          </div>
          <FormErrorMessage />
        </form>
      </div>
    </div>
  )
}
