import * as path from "node:path"
import type { FC } from "hono/jsx"
import { formatFileSize, formatTimestamp } from "../utils/formatters"
import { DeleteIcon } from "./icons/DeleteIcon"

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
        className="text-indigo-600 font-semibold no-underline hover:text-purple-600 transition-colors mx-1"
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
          className="text-indigo-600 font-semibold no-underline hover:text-purple-600 transition-colors mx-1"
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
export const FileList: FC<FileListProps> = ({ files, requestPath }) => {
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
      <nav className="mb-6 p-3 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl border border-indigo-200">
        {crumbs}
      </nav>
      <ul className="list-none p-0">
        {sortedFiles.map((file) => {
          const filePath = path.join(requestPath, file.name)
          const encodedPath = encodeURIComponent(filePath)

          return (
            <li
              key={file.name}
              className="flex justify-between items-center py-3 px-4 mb-2 rounded-xl border-2 border-transparent hover:border-indigo-300 hover:bg-gradient-to-r hover:from-indigo-50 hover:to-purple-50 cursor-pointer transition-all duration-200"
              hx-get={
                file.type === "dir"
                  ? `/browse?path=${encodedPath}`
                  : `/file?path=${encodedPath}`
              }
              hx-target={
                file.type === "dir"
                  ? "#file-list-container"
                  : "#file-viewer-container"
              }
              hx-push-url={
                file.type === "dir"
                  ? `/?path=${encodedPath}`
                  : `/file?path=${encodedPath}`
              }
            >
              {/* ファイル/ディレクトリ名リンク */}
              <span className="text-indigo-700 font-medium hover:text-purple-600 transition-colors">
                {file.type === "dir" ? `📁 ${file.name}/` : `📄 ${file.name}`}
              </span>

              <div className="flex gap-4 items-center">
                {/* ファイルサイズ表示（ファイルのみ） */}
                {file.type === "file" && (
                  <div className="hidden sm:block sm:w-30 text-right">
                    {formatFileSize(file.size || 0)}
                  </div>
                )}
                {/* タイムスタンプ表示 */}
                <div className="hidden sm:block sm:w-45 text-right text-gray-600 text-sm">
                  {file.mtime && formatTimestamp(new Date(file.mtime))}
                </div>
                {/* 削除ボタン */}
                <div className="flex justify-end">
                  <form
                    hx-post="/api/delete"
                    hx-target="#file-list-container"
                    hx-swap="innerHTML"
                    hx-confirm={`Are you sure you want to delete ${file.name}?`}
                  >
                    <input type="hidden" name="path" value={filePath} />
                    <button
                      type="submit"
                      title="Delete"
                      aria-label="Delete"
                      className="w-8 h-8 flex items-center justify-center bg-gradient-to-r from-red-500 to-pink-500 text-white font-semibold border-none rounded-lg cursor-pointer hover:from-red-600 hover:to-pink-600 transition-all transform hover:scale-105"
                    >
                      <DeleteIcon />
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
        className="mb-4 mt-6 p-4 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl border-2 border-indigo-200"
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
          className="px-4 py-2 border-2 border-indigo-300 rounded-lg mr-2 focus:outline-none focus:border-purple-500 transition-colors"
        />
        <button
          type="submit"
          className="px-6 py-2 bg-gradient-to-r from-indigo-500 to-purple-500 text-white font-semibold border-none rounded-lg cursor-pointer hover:from-indigo-600 hover:to-purple-600 transition-all transform hover:scale-105"
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
        className="my-4 p-4 bg-gradient-to-r from-purple-50 to-pink-50 rounded-xl border-2 border-purple-200"
      >
        <input type="hidden" name="path" value={requestPath} />
        <input
          type="file"
          name="file"
          required
          className="px-4 py-2 border-2 border-purple-300 rounded-lg mr-2 focus:outline-none focus:border-pink-500 transition-colors"
        />
        <button
          type="submit"
          className="px-6 py-2 bg-gradient-to-r from-purple-500 to-pink-500 text-white font-semibold border-none rounded-lg cursor-pointer hover:from-purple-600 hover:to-pink-600 transition-all transform hover:scale-105"
        >
          Upload
        </button>
      </form>
    </div>
  )
}
