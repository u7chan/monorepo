import type { FC } from "hono/jsx"

interface FileViewerProps {
  content?: string
  mimeType?: string
  fileName?: string
  path?: string
}

export const FileViewer: FC<FileViewerProps> = ({
  content,
  mimeType,
  fileName,
  path,
}) => {
  const encodedPath = path ? encodeURIComponent(path) : ""

  // テキストファイルの場合
  if (content !== undefined) {
    return (
      <div id="file-viewer-container" class="mt-4">
        <div class="mb-4">
          <a
            href="/"
            hx-get="/browse?path="
            hx-target="#file-list-container"
            hx-push-url="/"
          >
            ← Back to root
          </a>
        </div>
        <h2>{fileName}</h2>
        <pre class="bg-gray-100 p-4 rounded overflow-x-auto whitespace-pre-wrap break-words">
          {content}
        </pre>
      </div>
    )
  }

  // バイナリファイルの場合
  if (mimeType) {
    const fileUrl = `/file/raw?path=${encodedPath}`

    // 画像ファイル
    if (mimeType.startsWith("image/")) {
      return (
        <div id="file-viewer-container" class="mt-4">
          <div class="mb-4">
            <a
              href="/"
              hx-get="/browse?path="
              hx-target="#file-list-container"
              hx-push-url="/"
            >
              ← Back to root
            </a>
          </div>
          <h2>{fileName}</h2>
          <img src={fileUrl} alt={fileName} class="max-w-full rounded" />
        </div>
      )
    }

    // 動画ファイル
    if (mimeType.startsWith("video/")) {
      return (
        <div id="file-viewer-container" class="mt-4">
          <div class="mb-4">
            <a
              href="/"
              hx-get="/browse?path="
              hx-target="#file-list-container"
              hx-push-url="/"
            >
              ← Back to root
            </a>
          </div>
          <h2>{fileName}</h2>
          <video controls class="max-w-full rounded">
            <source src={fileUrl} type={mimeType} />
            <track kind="captions" src="" label="No captions" />
            Your browser does not support the video tag.
          </video>
        </div>
      )
    }

    // PDFファイル
    if (mimeType === "application/pdf") {
      return (
        <div id="file-viewer-container" class="mt-4">
          <div class="mb-4">
            <a
              href="/"
              hx-get="/browse?path="
              hx-target="#file-list-container"
              hx-push-url="/"
            >
              ← Back to root
            </a>
          </div>
          <h2>{fileName}</h2>
          <iframe
            src={fileUrl}
            class="w-full h-[80vh] border-none"
            title={fileName || "PDF Viewer"}
          />
        </div>
      )
    }
  }

  // デフォルト表示
  return (
    <div id="file-viewer-container" class="mt-4">
      <div class="mb-4">
        <a
          href="/"
          hx-get="/browse?path="
          hx-target="#file-list-container"
          hx-push-url="/"
        >
          ← Back to root
        </a>
      </div>
      <h2>{fileName}</h2>
      <p>Unable to display this file type.</p>
    </div>
  )
}
