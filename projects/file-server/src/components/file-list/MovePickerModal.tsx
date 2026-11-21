import type { FC } from "hono/jsx"
import {
  dismissButtonClassName,
  dismissIconButtonClassName,
  primaryButtonClassName,
} from "../buttonStyles"
import { CloseIcon } from "../icons/CloseIcon"
import { modalSurfaceClassName, mutedTextClassName } from "../uiStyles"
import { FormErrorMessage } from "./FormErrorMessage"
import { MovePickerNavigation } from "./MovePickerNavigation"
import { closePickerScript, isInsideSource } from "./movePickerPaths"
import type { FileItem } from "./types"

interface MovePickerModalProps {
  source: string
  sourceName: string
  currentDest: string
  pickerRoot: string
  roots: string[]
  directories: FileItem[]
}

export const MovePickerModal: FC<MovePickerModalProps> = ({
  source,
  sourceName,
  currentDest,
  pickerRoot,
  roots,
  directories,
}) => {
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

        <MovePickerNavigation
          source={source}
          currentDest={currentDest}
          pickerRoot={pickerRoot}
          roots={roots}
          directories={directories}
        />
        <form
          hx-post="/api/move"
          hx-target="#file-list-container"
          hx-swap="outerHTML"
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
