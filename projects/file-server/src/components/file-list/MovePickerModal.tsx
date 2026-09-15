import type { FC } from "hono/jsx"
import {
  buttonBaseClassName,
  dismissButtonClassName,
  dismissIconButtonClassName,
  primaryButtonClassName,
  secondaryToneClassName,
  smSizeClassName,
} from "../buttonStyles"
import { CloseIcon } from "../icons/CloseIcon"
import { FolderIcon } from "../icons/FolderIcon"
import { modalSurfaceClassName, mutedTextClassName } from "../uiStyles"
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

function rootButtonClassName(isActive: boolean): string {
  const tone = isActive
    ? "bg-indigo-600 text-white ring-1 ring-indigo-600 hover:bg-indigo-700"
    : secondaryToneClassName
  return `${buttonBaseClassName} ${tone} ${smSizeClassName} break-all`
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
      hx-on:click={closePickerScript}
    >
      <div
        className={`${modalSurfaceClassName} modal-enter flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden`}
        hx-on:click="event.stopPropagation();"
      >
        <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
          <h2 className="truncate text-base font-semibold text-slate-900">
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

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4">
          {roots.length > 1 ? (
            <div
              data-picker-roots
              className="mb-3 flex flex-shrink-0 flex-wrap gap-2"
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
            aria-label="Destination"
            className={`mb-2 flex flex-wrap items-center gap-y-1 break-all ${mutedTextClassName}`}
          >
            {breadcrumbs.map((crumb, idx) => {
              const isLast = idx === breadcrumbs.length - 1
              return (
                <span
                  key={`${crumb.label}:${crumb.path}`}
                  className="flex items-center"
                >
                  {idx > 0 && <span className="text-slate-300">/</span>}
                  <button
                    type="button"
                    hx-get={pickerHref(source, crumb.path)}
                    hx-target="#move-picker-container"
                    hx-swap="innerHTML"
                    aria-current={isLast ? "page" : undefined}
                    className={
                      isLast
                        ? "cursor-pointer px-1 font-medium text-slate-900"
                        : "cursor-pointer rounded px-1 text-slate-500 transition-colors hover:bg-slate-100 hover:text-indigo-600"
                    }
                  >
                    {crumb.label}
                  </button>
                </span>
              )
            })}
          </nav>

          <div
            data-picker-directories
            className="min-h-[8rem] flex-1 overflow-y-auto rounded-lg border border-slate-200"
          >
            {directories.length === 0 ? (
              <p className="px-4 py-8 text-center text-slate-400">
                No subdirectories here.
              </p>
            ) : (
              <ul className="m-0 list-none divide-y divide-slate-200 p-0">
                {directories.map((dir) => {
                  const dirPath = currentDest
                    ? `${currentDest}/${dir.name}`
                    : dir.name
                  return (
                    <li key={dir.name}>
                      <button
                        type="button"
                        hx-get={pickerHref(source, dirPath)}
                        hx-target="#move-picker-container"
                        hx-swap="innerHTML"
                        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-indigo-700"
                      >
                        <span className="flex-shrink-0 text-slate-400">
                          <FolderIcon />
                        </span>
                        <span className="break-all">{dir.name}/</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>

        <form
          hx-post="/api/move"
          hx-target="#file-list-container"
          hx-swap="innerHTML"
          data-inline-error-form
          data-move-form
          className="flex-shrink-0 border-t border-slate-200 px-5 py-4"
        >
          <input type="hidden" name="path" value={source} />
          <input type="hidden" name="destination" value={currentDest} />
          <p className={`mb-3 break-all ${mutedTextClassName}`}>
            Destination{" "}
            <span data-picker-destination className="font-mono text-slate-900">
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
          <div className="flex justify-end gap-2">
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
