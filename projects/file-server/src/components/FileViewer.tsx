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

  const closeButton = (
    <button
      type="button"
      onclick="document.getElementById('file-viewer-container').innerHTML = ''; document.body.style.overflow = 'auto'; history.pushState(null, '', '/');"
      class="px-4 py-2 bg-gray-600 text-white border-none rounded cursor-pointer hover:bg-gray-700"
    >
      Close
    </button>
  )

  // テキストファイルの場合
  if (content !== undefined) {
    return (
      <>
        <script
          dangerouslySetInnerHTML={{
            __html: "document.body.style.overflow = 'hidden';",
          }}
        />
        <div
          id="file-viewer-container"
          class="fixed inset-0  flex items-center justify-center z-50"
        >
          <div class="bg-white p-5 rounded-lg max-w-4xl w-full max-h-[80vh] overflow-auto border border-gray-300 shadow-lg">
            <div class="flex justify-between items-center mb-4">
              <h2 class="text-xl font-bold">{fileName}</h2>
              {closeButton}
            </div>
            <pre class="bg-gray-100 p-4 rounded overflow-x-auto whitespace-pre-wrap break-words">
              {content}
            </pre>
          </div>
        </div>
      </>
    )
  }

  // バイナリファイルの場合
  if (mimeType) {
    const fileUrl = `/file/raw?path=${encodedPath}`

    // 画像ファイル
    if (mimeType.startsWith("image/")) {
      return (
        <>
          <script
            dangerouslySetInnerHTML={{
              __html: "document.body.style.overflow = 'hidden';",
            }}
          />
          <div
            id="file-viewer-container"
            class="fixed inset-0  flex items-center justify-center z-50"
          >
            <div class="bg-white p-5 rounded-lg max-w-4xl w-full max-h-[80vh] overflow-auto border border-gray-300 shadow-lg">
              <div class="flex justify-between items-center mb-4">
                <h2 class="text-xl font-bold">{fileName}</h2>
                {closeButton}
              </div>
              <img src={fileUrl} alt={fileName} class="max-w-full rounded" />
            </div>
          </div>
        </>
      )
    }

    // 動画ファイル
    if (mimeType.startsWith("video/")) {
      return (
        <>
          <script
            dangerouslySetInnerHTML={{
              __html: "document.body.style.overflow = 'hidden';",
            }}
          />
          <div
            id="file-viewer-container"
            class="fixed inset-0  flex items-center justify-center z-50"
          >
            <div class="bg-white p-5 rounded-lg max-w-4xl w-full max-h-[80vh] overflow-auto border border-gray-300 shadow-lg">
              <div class="flex justify-between items-center mb-4">
                <h2 class="text-xl font-bold">{fileName}</h2>
                {closeButton}
              </div>
              <video controls class="max-w-full rounded">
                <source src={fileUrl} type={mimeType} />
                <track kind="captions" src="" label="No captions" />
                Your browser does not support the video tag.
              </video>
            </div>
          </div>
        </>
      )
    }

    // PDFファイル
    if (mimeType === "application/pdf") {
      return (
        <>
          <script
            dangerouslySetInnerHTML={{
              __html: "document.body.style.overflow = 'hidden';",
            }}
          />
          <div
            id="file-viewer-container"
            class="fixed inset-0  flex items-center justify-center z-50"
          >
            <div class="bg-white p-5 rounded-lg max-w-4xl w-full max-h-[80vh] overflow-auto border border-gray-300 shadow-lg">
              <div class="flex justify-between items-center mb-4">
                <h2 class="text-xl font-bold">{fileName}</h2>
                {closeButton}
              </div>
              <iframe
                src={fileUrl}
                class="w-full h-[70vh] border-none"
                title={fileName || "PDF Viewer"}
              ></iframe>
            </div>
          </div>
        </>
      )
    }
  }

  // デフォルト表示（ダウンロードリンク）
  return (
    <>
      <script
        dangerouslySetInnerHTML={{
          __html: "document.body.style.overflow = 'hidden';",
        }}
      />
      <div
        id="file-viewer-container"
        class="fixed inset-0  flex items-center justify-center z-50"
      >
        <div class="bg-white p-5 rounded-lg max-w-4xl w-full max-h-[80vh] overflow-auto">
          <div class="flex justify-between items-center mb-4">
            <h2 class="text-xl font-bold">{fileName}</h2>
            {closeButton}
          </div>
          <p>This file type cannot be displayed in the browser.</p>
          <a
            href={`/file/raw?path=${encodedPath}`}
            download={fileName}
            class="px-4 py-2 bg-blue-600 text-white border-none rounded cursor-pointer hover:bg-blue-700 inline-block mt-2"
          >
            Download File
          </a>
        </div>
      </div>
    </>
  )
}
