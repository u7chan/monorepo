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
      class="px-6 py-3 bg-gradient-to-r from-rose-500 to-pink-500 text-white font-bold border-none rounded-xl cursor-pointer hover:from-rose-600 hover:to-pink-600 transition-all transform hover:scale-110 hover:shadow-xl shadow-md"
    >
      ✕ Close
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
          class="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50"
        >
          <div class="bg-white p-6 rounded-2xl max-w-4xl w-full max-h-[80vh] overflow-auto border-4 border-indigo-300">
            <div class="flex justify-between items-center mb-6 pb-4 border-b-2 border-indigo-200">
              <h2 class="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent truncate max-w-[70%]">{fileName}</h2>
              {closeButton}
            </div>
            <pre class="bg-gradient-to-br from-indigo-50 to-purple-50 p-4 rounded-xl overflow-x-auto whitespace-pre-wrap break-words border-2 border-indigo-200">
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
            class="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50"
          >
            <div class="bg-white p-6 rounded-2xl max-w-4xl w-full max-h-[80vh] overflow-auto border-4 border-purple-300">
              <div class="flex justify-between items-center mb-4">
                <h2 class="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">{fileName}</h2>
                {closeButton}
              </div>
              <img src={fileUrl} alt={fileName} class="max-w-full rounded-xl border-2 border-indigo-200" />
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
            class="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50"
          >
            <div class="bg-white p-6 rounded-2xl max-w-4xl w-full max-h-[80vh] overflow-auto border-4 border-pink-300">
              <div class="flex justify-between items-center mb-4">
                <h2 class="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">{fileName}</h2>
                {closeButton}
              </div>
              <video controls class="max-w-full rounded-xl border-2 border-pink-200">
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
            class="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50"
          >
            <div class="bg-white p-6 rounded-2xl max-w-4xl w-full max-h-[80vh] overflow-auto border-4 border-indigo-300">
              <div class="flex justify-between items-center mb-4">
                <h2 class="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">{fileName}</h2>
                {closeButton}
              </div>
              <iframe
                src={fileUrl}
                class="w-full h-[70vh] border-2 border-indigo-200 rounded-xl"
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
        class="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50"
      >
        <div class="bg-white p-6 rounded-2xl max-w-4xl w-full max-h-[80vh] overflow-auto border-4 border-purple-300 animate-[slideIn_0.2s_ease-out]">
          <div class="flex justify-between items-center mb-4">
            <h2 class="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">{fileName}</h2>
            {closeButton}
          </div>
          <p class="mb-6 text-gray-600 text-lg">This file type cannot be displayed in the browser.</p>
          <a
            href={`/file/raw?path=${encodedPath}`}
            download={fileName}
            class="px-8 py-4 bg-gradient-to-r from-indigo-500 to-purple-500 text-white font-bold text-lg border-none rounded-xl cursor-pointer hover:from-indigo-600 hover:to-purple-600 transition-all transform hover:scale-110 hover:shadow-xl shadow-md inline-block mt-2"
          >
            ⬇ Download File
          </a>
        </div>
      </div>
    </>
  )
}
