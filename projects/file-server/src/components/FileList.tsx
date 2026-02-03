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
      <nav style={{ marginBottom: "1em" }}>{crumbs}</nav>
      <hr />

      {/* ファイルリスト */}
      <ul>
        {sortedFiles.map((file) => {
          const filePath = path.join(requestPath, file.name)
          const encodedPath = encodeURIComponent(filePath)

          return (
            <li
              key={file.name}
              style={{
                display: "flex",
                justifyContent: "space-between",
              }}
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

              <div class="file-actions">
                {/* ファイルサイズ表示（ファイルのみ） */}
                {file.type === "file" && (
                  <div class="file-size">{formatFileSize(file.size || 0)}</div>
                )}
                {/* タイムスタンプ表示 */}
                <div class="file-mtime">
                  {file.mtime && formatTimestamp(new Date(file.mtime))}
                </div>
                {/* 削除ボタン */}
                <div style={{ width: "80px" }}>
                  <form
                    hx-post="/api/delete"
                    hx-target="#file-list-container"
                    hx-swap="innerHTML"
                    hx-confirm={`Are you sure you want to delete ${file.name}?`}
                  >
                    <input type="hidden" name="path" value={filePath} />
                    <button type="submit" class="delete-btn">
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
        style={{ marginBottom: "1em", marginTop: "1em" }}
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
          style={{ marginRight: "0.5em" }}
        />
        <button type="submit">Create Folder</button>
      </form>

      {/* アップロードフォーム */}
      <form
        hx-post="/api/upload"
        hx-target="#file-list-container"
        hx-swap="innerHTML"
        hx-encoding="multipart/form-data"
      >
        <input type="hidden" name="path" value={requestPath} />
        <input type="file" name="file" required />
        <button type="submit">Upload</button>
      </form>
    </div>
  )
}

// 完全なFileListコンポーネント（後方互換性のため）
export const FileList: FC<FileListProps> = ({ files, requestPath }) => {
  return <FileListContent files={files} requestPath={requestPath} />
}
