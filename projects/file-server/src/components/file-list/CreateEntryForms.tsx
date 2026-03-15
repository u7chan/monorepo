import { primaryButtonClassName } from "../buttonStyles"
import { FormErrorMessage } from "./FormErrorMessage"

interface CreateEntryFormsProps {
	folderPath: string
}

export function CreateEntryForms({ folderPath }: CreateEntryFormsProps) {
	return (
		<>
			<form
				id="new-file-form"
				data-inline-error-form
				hx-post="/api/file"
				hx-target="#file-list-container"
				hx-swap="innerHTML"
				className="hidden mb-4 p-4 bg-white rounded-xl border-2 border-indigo-200"
			>
				<input type="hidden" name="path" value={folderPath} />
				<input
					type="text"
					name="file"
					placeholder="New file name"
					required
					className="px-4 py-2 border-2 border-indigo-300 rounded-lg mr-2 focus:outline-none focus:border-purple-500 transition-colors"
				/>
				<button type="submit" className={`${primaryButtonClassName} px-6`}>
					Create File
				</button>
				<FormErrorMessage />
			</form>

			<form
				id="new-folder-form"
				data-inline-error-form
				hx-post="/api/mkdir"
				hx-target="#file-list-container"
				hx-swap="innerHTML"
				className="hidden mb-4 p-4 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl border-2 border-indigo-200"
			>
				<input type="hidden" name="path" value={folderPath} />
				<input
					type="text"
					name="folder"
					placeholder="New folder name"
					required
					className="px-4 py-2 border-2 border-indigo-300 rounded-lg mr-2 focus:outline-none focus:border-purple-500 transition-colors"
				/>
				<button type="submit" className={`${primaryButtonClassName} px-6`}>
					Create Folder
				</button>
				<FormErrorMessage />
			</form>
		</>
	)
}
