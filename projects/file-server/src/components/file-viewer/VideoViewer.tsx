import type { FC } from "hono/jsx"

interface VideoViewerProps {
  fileUrl: string
  mimeType: string
}

export const VideoViewer: FC<VideoViewerProps> = ({ fileUrl, mimeType }) => {
  return (
    <div className="flex-1 overflow-auto flex justify-center items-center">
      <video
        controls
        className="max-w-full rounded-xl border-2 border-pink-200"
      >
        <source src={fileUrl} type={mimeType} />
        <track kind="captions" src="" label="No captions" />
        Your browser does not support the video tag.
      </video>
    </div>
  )
}
