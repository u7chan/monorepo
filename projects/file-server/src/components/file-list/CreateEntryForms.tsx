import { primaryButtonClassName } from "../buttonStyles"
import { fieldClassName, insetPanelClassName } from "../uiStyles"
import { FormErrorMessage } from "./FormErrorMessage"

interface CreateEntryFormsProps {
  folderPath?: string
}

export function CreateEntryForms({ folderPath }: CreateEntryFormsProps) {
  if (!folderPath) {
    return null
  }

  return (
    <>
      <form
        id="new-file-form"
        data-inline-error-form
        hx-post="/api/file"
        hx-target="#file-list-container"
        hx-swap="outerHTML"
        className={`hidden ${insetPanelClassName} p-4`}
      >
        <input type="hidden" name="path" value={folderPath} />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="text"
            name="file"
            placeholder="New file name"
            aria-label="New file name"
            required
            className={`${fieldClassName} sm:max-w-sm`}
          />
          <button type="submit" className={primaryButtonClassName}>
            Create File
          </button>
        </div>
        <FormErrorMessage />
      </form>

      <form
        id="new-folder-form"
        data-inline-error-form
        hx-post="/api/mkdir"
        hx-target="#file-list-container"
        hx-swap="outerHTML"
        className={`hidden ${insetPanelClassName} p-4`}
      >
        <input type="hidden" name="path" value={folderPath} />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="text"
            name="folder"
            placeholder="New folder name"
            aria-label="New folder name"
            required
            className={`${fieldClassName} sm:max-w-sm`}
          />
          <button type="submit" className={primaryButtonClassName}>
            Create Folder
          </button>
        </div>
        <FormErrorMessage />
      </form>
    </>
  )
}
