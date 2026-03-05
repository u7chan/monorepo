import type { FC } from "hono/jsx"

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
        className="flex-1 w-full bg-gradient-to-br from-indigo-50 to-purple-50 p-4 rounded-xl border-2 border-indigo-200 resize-none font-mono text-sm leading-relaxed focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200"
        style="min-height: 300px;"
      >
        {content}
      </textarea>
      <div className="flex justify-end gap-2 mt-4 pt-4 border-t-2 border-indigo-200">
        <button
          type="button"
          className="px-4 py-2 bg-gradient-to-r from-gray-400 to-gray-500 text-white font-bold text-base border-none rounded-xl cursor-pointer hover:from-gray-500 hover:to-gray-600 transition-all"
          hx-get={`/file/?path=${encodedPath}`}
          hx-target="#file-viewer-container"
          hx-swap="outerHTML"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="px-4 py-2 bg-gradient-to-r from-emerald-500 to-teal-500 text-white font-bold text-base border-none rounded-xl cursor-pointer hover:from-emerald-600 hover:to-teal-600 transition-all transform hover:scale-105 hover:shadow-xl shadow-md"
        >
          Save
        </button>
      </div>
    </form>
  )
}
