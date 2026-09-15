import type { FC } from "hono/jsx"

interface TextViewerProps {
  content: string
}

export const TextViewer: FC<TextViewerProps> = ({ content }) => {
  if (content.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-lg bg-slate-50 p-6 text-center text-sm text-slate-400">
        This file is empty.
        <span data-copy-source style="display:none" />
      </div>
    )
  }

  return (
    <pre
      data-copy-source
      className="flex-1 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-4 font-mono text-sm text-slate-800"
    >
      {content}
    </pre>
  )
}
