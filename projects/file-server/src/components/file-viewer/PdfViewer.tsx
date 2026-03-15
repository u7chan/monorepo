import type { FC } from "hono/jsx"

interface PdfViewerProps {
  fileUrl: string
  fileName?: string
}

export const PdfViewer: FC<PdfViewerProps> = ({ fileUrl, fileName }) => {
  return (
    <div className="pdf-viewer-shell flex-1 min-h-0">
      <iframe
        src={fileUrl}
        className="pdf-viewer-frame h-full w-full rounded-xl border-2 border-indigo-200 bg-white"
        title={fileName || "PDF Viewer"}
      ></iframe>
    </div>
  )
}
