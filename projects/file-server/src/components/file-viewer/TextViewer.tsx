import type { FC } from "hono/jsx"

interface TextViewerProps {
  content: string
}

export const TextViewer: FC<TextViewerProps> = ({ content }) => {
  return (
    <pre className="bg-gradient-to-br from-indigo-50 to-purple-50 p-4 rounded-xl overflow-auto whitespace-pre-wrap break-words border-2 border-indigo-200 flex-1">
      {content}
    </pre>
  )
}
