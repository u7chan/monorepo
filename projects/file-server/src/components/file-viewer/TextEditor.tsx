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
      className="flex min-h-0 flex-1 flex-col"
      hx-post="/api/update"
      hx-target="#file-viewer-container"
      hx-swap="outerHTML"
    >
      <input type="hidden" name="path" value={path} />
      <textarea
        data-copy-source
        name="content"
        placeholder="This file is empty. Start typing..."
        className="w-full flex-1 resize-none rounded-lg border border-slate-300 bg-white p-4 font-mono text-sm leading-relaxed text-slate-800 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
        style="min-height: 300px;"
      >
        {content}
      </textarea>
      <div className="mt-4 flex justify-end gap-2 border-t border-slate-200 pt-4">
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
