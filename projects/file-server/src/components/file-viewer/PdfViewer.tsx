import type { FC } from "hono/jsx"

interface PdfViewerProps {
  fileUrl: string
  fileName?: string
}

export const PdfViewer: FC<PdfViewerProps> = ({ fileUrl, fileName }) => {
  return (
    <div className="flex-1 overflow-auto flex justify-center items-center">
      <iframe
        src={fileUrl}
        className="w-full h-full border-2 border-indigo-200 rounded-xl"
        title={fileName || "PDF Viewer"}
      ></iframe>
    </div>
  )
}
