import type { FC } from "hono/jsx"

interface ImageViewerProps {
  fileUrl: string
  fileName?: string
}

export const ImageViewer: FC<ImageViewerProps> = ({ fileUrl, fileName }) => {
  return (
    <div className="flex-1 overflow-hidden flex justify-center items-center min-h-0">
      <img
        src={fileUrl}
        alt={fileName}
        className="max-w-full object-contain image-viewer-img"
      />
    </div>
  )
}
