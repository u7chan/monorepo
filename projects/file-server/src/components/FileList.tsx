import * as path from "node:path"
import type { FC } from "hono/jsx"
import { formatFileSize, formatTimestamp } from "../utils/formatters"

export interface FileItem {
  name: string
  type: "file" | "dir"
  size?: number
  mtime?: Date
}

interface FileListProps {
  files: FileItem[]
  requestPath: string
}

// パンくずリスト部分を生成
function generateBreadcrumbs(requestPath: string) {
  const parts = requestPath.split("/").filter(Boolean)
  const crumbs = []
  let acc = ""

  crumbs.push(
    <span key="root">
      <a
        href="/"
        hx-get="/browse?path="
        hx-target="#file-list-container"
        hx-push-url="/?path="
        class="text-blue-600 no-underline hover:underline mx-1"
      >
        root
      </a>
      {parts.length > 0 ? " / " : ""}
    </span>,
  )

  parts.forEach((part, idx) => {
    acc += (acc ? "/" : "") + part
    const isLast = idx === parts.length - 1
    const encodedAcc = encodeURIComponent(acc)
    crumbs.push(
      <span key={acc}>
        <a
          href={`/?path=${encodedAcc}`}
          hx-get={`/browse?path=${encodedAcc}`}
          hx-target="#file-list-container"
          hx-push-url={`/?path=${encodedAcc}`}
          class="text-blue-600 no-underline hover:underline mx-1"
        >
          {part}
        </a>
        {!isLast ? " / " : ""}
      </span>,
    )
  })

  return crumbs
}

// ファイルリストの内容部分（htmx用部分テンプレート）
export const FileListContent: FC<FileListProps> = ({ files, requestPath }) => {
  const sortedFiles = [...files].sort((a, b) => {
    if (a.type === b.type) {
      return a.name.localeCompare(b.name)
    }
    return a.type === "dir" ? -1 : 1
  })

  const crumbs = generateBreadcrumbs(requestPath)

  return (
    <div id="file-list-container">
      {/* パンくずリスト */}
      <nav class="mb-4">{crumbs}</nav>
      <hr />
      <ul class="list-none p-0">
        {sortedFiles.map((file) => {
          const filePath = path.join(requestPath, file.name)
          const encodedPath = encodeURIComponent(filePath)

          return (
            <li
              key={file.name}
              class="flex justify-between items-center py-2 border-b border-gray-200 hover:bg-gray-50"
            >
              {/* ファイル/ディレクトリ名リンク */}
              {file.type === "dir" ? (
                <a
                  href={`/?path=${encodedPath}`}
                  hx-get={`/browse?path=${encodedPath}`}
                  hx-target="#file-list-container"
                  hx-push-url={`/?path=${encodedPath}`}
                >
                  {file.name}/
                </a>
              ) : (
                <a
                  href={`/file?path=${encodedPath}`}
                  hx-get={`/file?path=${encodedPath}`}
                  hx-target="#file-viewer-container"
                  hx-push-url={`/file?path=${encodedPath}`}
                >
                  {file.name}
                </a>
              )}

              <div class="flex gap-4 items-center">
                {/* ファイルサイズ表示（ファイルのみ） */}
                {file.type === "file" && (
                  <div class="w-30 text-right">
                    {formatFileSize(file.size || 0)}
                  </div>
                )}
                {/* タイムスタンプ表示 */}
                <div class="w-45 text-right text-gray-600 text-sm">
                  {file.mtime && formatTimestamp(new Date(file.mtime))}
                </div>
                {/* 削除ボタン */}
                <div class="w-20">
                  <form
                    hx-post="/api/delete"
                    hx-target="#file-list-container"
                    hx-swap="innerHTML"
                    hx-confirm={`Are you sure you want to delete ${file.name}?`}
                  >
                    <input type="hidden" name="path" value={filePath} />
                    <button
                      type="submit"
                      class="px-4 py-2 bg-red-600 text-white border-none rounded cursor-pointer hover:bg-red-700"
                    >
                      Delete
                    </button>
                  </form>
                </div>
              </div>
            </li>
          )
        })}
      </ul>

      {/* フォルダ作成フォーム */}
      <form
        hx-post="/api/mkdir"
        hx-target="#file-list-container"
        hx-swap="innerHTML"
        class="mb-4 mt-4"
      >
        <input
          type="hidden"
          name="path"
          value={
            requestPath
              ? requestPath + (requestPath.endsWith("/") ? "" : "/")
              : ""
          }
        />
        <input
          type="text"
          name="folder"
          placeholder="New folder name"
          required
          class="px-2 py-1 border border-gray-300 rounded mr-2"
        />
        <button
          type="submit"
          class="px-4 py-2 bg-blue-600 text-white border-none rounded cursor-pointer hover:bg-blue-700"
        >
          Create Folder
        </button>
      </form>

      {/* アップロードフォーム */}
      <form
        hx-post="/api/upload"
        hx-target="#file-list-container"
        hx-swap="innerHTML"
        hx-encoding="multipart/form-data"
        class="my-4"
      >
        <input type="hidden" name="path" value={requestPath} />
        <input
          type="file"
          name="file"
          required
          class="px-2 py-1 border border-gray-300 rounded mr-2"
        />
        <button
          type="submit"
          class="px-4 py-2 bg-blue-600 text-white border-none rounded cursor-pointer hover:bg-blue-700"
        >
          Upload
        </button>
      </form>
    </div>
  )
}

// 完全なFileListコンポーネント（後方互換性のため）
export const FileList: FC<FileListProps> = ({ files, requestPath }) => {
  return <FileListContent files={files} requestPath={requestPath} />
}
