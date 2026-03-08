import type { FC } from "hono/jsx"
import { dismissButtonClassName, primaryButtonClassName } from "../buttonStyles"

interface TextEditorProps {
  content: string
  path: string
}

export const TextEditor: FC<TextEditorProps> = ({ content, path }) => {
  const encodedPath = encodeURIComponent(path)

  return (
    <form
      className="flex flex-col flex-1 min-h-0"
      hx-post="/api/update"
      hx-target="#file-viewer-container"
      hx-swap="outerHTML"
    >
      <input type="hidden" name="path" value={path} />
      <textarea
        name="content"
        placeholder="This file is empty. Start typing..."
        className="flex-1 w-full bg-gradient-to-br from-indigo-50 to-purple-50 p-4 rounded-xl border-2 border-indigo-200 resize-none font-mono text-sm leading-relaxed focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200"
        style="min-height: 300px;"
      >
        {content}
      </textarea>
      <div className="flex justify-end gap-2 mt-4 pt-4 border-t-2 border-indigo-200">
        <button
          type="button"
          className={dismissButtonClassName}
          hx-get={`/file?path=${encodedPath}`}
          hx-target="#file-viewer-container"
          hx-swap="outerHTML"
        >
          Cancel
        </button>
        <button type="submit" className={primaryButtonClassName}>
          Save
        </button>
      </div>
    </form>
  )
}
