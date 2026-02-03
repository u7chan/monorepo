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
      <div id="file-viewer-container" class="viewer-container">
        <div style={{ marginBottom: "1em" }}>
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
        <pre>{content}</pre>
      </div>
    )
  }

  // バイナリファイルの場合
  if (mimeType) {
    const fileUrl = `/file/raw?path=${encodedPath}`

    // 画像ファイル
    if (mimeType.startsWith("image/")) {
      return (
        <div id="file-viewer-container" class="viewer-container">
          <div style={{ marginBottom: "1em" }}>
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
          <img src={fileUrl} alt={fileName} style={{ maxWidth: "100%" }} />
        </div>
      )
    }

    // 動画ファイル
    if (mimeType.startsWith("video/")) {
      return (
        <div id="file-viewer-container" class="viewer-container">
          <div style={{ marginBottom: "1em" }}>
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
          <video controls style={{ maxWidth: "100%" }}>
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
        <div id="file-viewer-container" class="viewer-container">
          <div style={{ marginBottom: "1em" }}>
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
            style={{ width: "100%", height: "80vh", border: "none" }}
            title={fileName || "PDF Viewer"}
          />
        </div>
      )
    }
  }

  // デフォルト表示
  return (
    <div id="file-viewer-container" class="viewer-container">
      <div style={{ marginBottom: "1em" }}>
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
