import type { FC } from "hono/jsx"

interface ImageViewerProps {
  fileUrl: string
  fileName?: string
}

export const ImageViewer: FC<ImageViewerProps> = ({ fileUrl, fileName }) => {
  return (
    <div className="flex-1 overflow-auto flex justify-center items-center">
      <img
        src={fileUrl}
        alt={fileName}
        className="max-w-full rounded-xl border-2 border-indigo-200"
      />
    </div>
  )
}
