import * as path from "node:path"
import type { FC } from "hono/jsx"
import { formatFileSize, formatTimestamp } from "../utils/formatters"

interface FileItem {
  name: string
  type: "file" | "dir"
  size?: number
  mtime?: Date
}

interface FileListProps {
  files: FileItem[]
  requestPath: string
}

export const FileList: FC<FileListProps> = ({ files, requestPath }) => {
  const sortedFiles = [...files].sort((a, b) => {
    if (a.type === b.type) {
      return a.name.localeCompare(b.name)
    }
    return a.type === "dir" ? -1 : 1
  })

  // requestPathを"/"で分割し、各階層のリンクを生成
  const parts = requestPath.split("/").filter(Boolean)
  const crumbs = []
  let acc = ""

  // ルート
  crumbs.push(
    <span key="root">
      <a href="/">root</a>
      {parts.length > 0 ? " / " : ""}
    </span>,
  )

  parts.forEach((part, idx) => {
    acc += (acc ? "/" : "") + part
    const isLast = idx === parts.length - 1
    crumbs.push(
      <span key={acc}>
        <a href={`/?path=${encodeURIComponent(acc)}`}>{part}</a>
        {!isLast ? " / " : ""}
      </span>,
    )
  })

  return (
    <div>
      {/* パンくずリストの追加 */}
      <nav style={{ marginBottom: "1em" }}>{crumbs}</nav>
      <hr />
      <ul>
        {sortedFiles.map((file) => (
          <li
            key={file.name}
            style={{
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <a
              href={`/?path=${encodeURIComponent(
                path.join(requestPath, file.name),
              )}`}
            >
              {file.name}
              {file.type === "dir" ? "/" : ""}
            </a>
            <div style={{ display: "flex", gap: "1em" }}>
              {/* ファイルサイズ表示（ファイルのみ） */}
              {file.type === "file" && (
                <div
                  style={{
                    width: "120px",
                    textAlign: "right",
                    margin: "0 1em",
                  }}
                >
                  {formatFileSize(file.size || 0)}
                </div>
              )}
              {/* タイムスタンプ表示 */}
              <div style={{ width: "180px", textAlign: "right" }}>
                {file.mtime && formatTimestamp(new Date(file.mtime))}
              </div>
              <div
                style={{ width: "80px", display: "flex", alignItems: "center" }}
              >
                <form method="post" action="/api/delete">
                  <input
                    type="hidden"
                    name="path"
                    value={path.join(requestPath, file.name)}
                  />
                  <button type="submit">Delete</button>
                </form>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <form action="/api/mkdir" method="post" style={{ marginBottom: "1em" }}>
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
      <form action="/api/upload" method="post" encType="multipart/form-data">
        <input type="hidden" name="path" value={requestPath} />
        <input type="file" name="file" required />
        <button type="submit">Upload</button>
      </form>
    </div>
  )
}
