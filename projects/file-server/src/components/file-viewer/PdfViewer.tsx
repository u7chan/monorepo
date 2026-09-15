import type { FC } from "hono/jsx"

interface PdfViewerProps {
  fileUrl: string
  fileName?: string
}

export const PdfViewer: FC<PdfViewerProps> = ({ fileUrl, fileName }) => {
  return (
    <div className="pdf-viewer-shell min-h-0 flex-1">
      <iframe
        src={fileUrl}
        className="pdf-viewer-frame h-full w-full rounded-lg border border-slate-200 bg-white"
        title={fileName || "PDF Viewer"}
      ></iframe>
    </div>
  )
}
