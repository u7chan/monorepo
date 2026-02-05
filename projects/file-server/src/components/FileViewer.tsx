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

  const downloadButton = path ? (
    <a
      href={`/file/raw?path=${encodedPath}`}
      download={fileName || true}
      className="px-6 py-3 bg-gradient-to-r from-indigo-500 to-purple-500 text-white font-bold text-base border-none rounded-xl cursor-pointer hover:from-indigo-600 hover:to-purple-600 transition-all transform hover:scale-110 hover:shadow-xl shadow-md inline-block"
    >
      ⬇
    </a>
  ) : null

  const closeButton = (
    <button
      type="button"
      onclick="document.getElementById('file-viewer-container').innerHTML = ''; document.body.style.overflow = 'auto'; history.pushState(null, '', '/');"
      className="px-6 py-3 bg-gradient-to-r from-rose-500 to-pink-500 text-white font-bold text-base border-none rounded-xl cursor-pointer hover:from-rose-600 hover:to-pink-600 transition-all transform hover:scale-110 hover:shadow-xl shadow-md"
    >
      ✕
    </button>
  )

  // テキストファイルの場合
  if (content !== undefined) {
    return (
      <div id="file-viewer-container">
        <script
          dangerouslySetInnerHTML={{
            __html: "document.body.style.overflow = 'hidden';",
          }}
        />
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded-2xl max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col border-4 border-indigo-300">
            <div className="flex justify-between items-center mb-4 pb-4 border-b-2 border-indigo-200 flex-shrink-0">
              <h2 className="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent truncate max-w-[70%]">
                {fileName}
              </h2>
              <div className="flex items-center gap-2">
                {downloadButton}
                {closeButton}
              </div>
            </div>
            <pre className="bg-gradient-to-br from-indigo-50 to-purple-50 p-4 rounded-xl overflow-auto whitespace-pre-wrap break-words border-2 border-indigo-200 flex-1">
              {content}
            </pre>
          </div>
        </div>
      </div>
    )
  }

  // バイナリファイルの場合
  if (mimeType) {
    const fileUrl = `/file/raw?path=${encodedPath}`

    // 画像ファイル
    if (mimeType.startsWith("image/")) {
      return (
        <div id="file-viewer-container">
          <script
            dangerouslySetInnerHTML={{
              __html: "document.body.style.overflow = 'hidden';",
            }}
          />
          <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
            <div className="bg-white p-6 rounded-2xl max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col border-4 border-purple-300">
              <div className="flex justify-between items-center mb-4 pb-4 border-b-2 border-indigo-200 flex-shrink-0">
                <h2 className="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent truncate max-w-[70%]">
                  {fileName}
                </h2>
                <div className="flex items-center gap-2">
                  {downloadButton}
                  {closeButton}
                </div>
              </div>
              <div className="flex-1 overflow-auto flex justify-center items-center">
                <img
                  src={fileUrl}
                  alt={fileName}
                  className="max-w-full rounded-xl border-2 border-indigo-200"
                />
              </div>
            </div>
          </div>
        </div>
      )
    }

    // 動画ファイル
    if (mimeType.startsWith("video/")) {
      return (
        <div id="file-viewer-container">
          <script
            dangerouslySetInnerHTML={{
              __html: "document.body.style.overflow = 'hidden';",
            }}
          />
          <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
            <div className="bg-white p-6 rounded-2xl max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col border-4 border-pink-300">
              <div className="flex justify-between items-center mb-4 pb-4 border-b-2 border-indigo-200 flex-shrink-0">
                <h2 className="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent truncate max-w-[70%]">
                  {fileName}
                </h2>
                <div className="flex items-center gap-2">
                  {downloadButton}
                  {closeButton}
                </div>
              </div>
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
            </div>
          </div>
        </div>
      )
    }

    // PDFファイル
    if (mimeType === "application/pdf") {
      return (
        <div id="file-viewer-container">
          <script
            dangerouslySetInnerHTML={{
              __html: "document.body.style.overflow = 'hidden';",
            }}
          />
          <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
            <div className="bg-white p-6 rounded-2xl max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col border-4 border-indigo-300">
              <div className="flex justify-between items-center mb-4 pb-4 border-b-2 border-indigo-200 flex-shrink-0">
                <h2 className="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent truncate max-w-[70%]">
                  {fileName}
                </h2>
                <div className="flex items-center gap-2">
                  {downloadButton}
                  {closeButton}
                </div>
              </div>
              <div className="flex-1 overflow-auto flex justify-center items-center">
                <iframe
                  src={fileUrl}
                  className="w-full h-full border-2 border-indigo-200 rounded-xl"
                  title={fileName || "PDF Viewer"}
                ></iframe>
              </div>
            </div>
          </div>
        </div>
      )
    }
  }

  // デフォルト表示（ダウンロードリンク）
  return (
    <div id="file-viewer-container">
      <script
        dangerouslySetInnerHTML={{
          __html: "document.body.style.overflow = 'hidden';",
        }}
      />
      <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
        <div className="bg-white p-6 rounded-2xl max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col border-4 border-purple-300 animate-[slideIn_0.2s_ease-out]">
          <div className="flex justify-between items-center mb-4 pb-4 border-b-2 border-indigo-200 flex-shrink-0">
            <h2 className="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent truncate max-w-[70%]">
              {fileName}
            </h2>
            <div className="flex items-center gap-2">
              {downloadButton}
              {closeButton}
            </div>
          </div>
          <div className="flex-1 overflow-auto flex justify-center items-center">
            <p className="mb-6 text-gray-600 text-lg text-center">
              This file type cannot be displayed in the browser.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
