import type { FC } from "hono/jsx"

interface TextViewerProps {
  content: string
}

export const TextViewer: FC<TextViewerProps> = ({ content }) => {
  if (content.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-xl border-2 border-dashed border-indigo-200 bg-gradient-to-br from-indigo-50 to-purple-50 p-6 text-center text-sm text-slate-600">
        This file is empty.
      </div>
    )
  }

  return (
    <pre className="bg-gradient-to-br from-indigo-50 to-purple-50 p-4 rounded-xl overflow-auto whitespace-pre-wrap break-words border-2 border-indigo-200 flex-1">
      {content}
    </pre>
  )
}
