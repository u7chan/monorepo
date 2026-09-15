import type { FC } from "hono/jsx"

interface VideoViewerProps {
  fileUrl: string
  mimeType: string
}

export const VideoViewer: FC<VideoViewerProps> = ({ fileUrl, mimeType }) => {
  return (
    <div className="flex flex-1 items-center justify-center overflow-auto rounded-lg bg-slate-900/95 p-4">
      <video controls className="max-w-full rounded-md">
        <source src={fileUrl} type={mimeType} />
        <track kind="captions" src="" label="No captions" />
        Your browser does not support the video tag.
      </video>
    </div>
  )
}
