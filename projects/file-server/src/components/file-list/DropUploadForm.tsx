import { fileInputChangeScript } from "./clientActions"

interface DropUploadFormProps {
  requestPath: string
}

export function DropUploadForm({ requestPath }: DropUploadFormProps) {
  return (
    <>
      <form
        id="drop-upload-form"
        hx-post="/api/upload"
        hx-target="#file-list-container"
        hx-swap="innerHTML"
        hx-encoding="multipart/form-data"
        className="hidden"
      >
        <input type="hidden" name="path" value={requestPath} />
      </form>
      <input
        type="file"
        name="files"
        id="drop-upload-input"
        multiple
        form="drop-upload-form"
        className="absolute opacity-0 w-px h-px overflow-hidden"
        hx-on:change={fileInputChangeScript}
      />
    </>
  )
}
