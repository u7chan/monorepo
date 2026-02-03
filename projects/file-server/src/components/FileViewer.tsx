import type { FC } from "hono/jsx"

interface FileViewerProps {
  content: string
}

export const FileViewer: FC<FileViewerProps> = ({ content }) => {
  return <pre>{content}</pre>
}
