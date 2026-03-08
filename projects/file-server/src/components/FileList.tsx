import * as path from "node:path"
import type { FC } from "hono/jsx"
import { formatFileSize, formatTimestamp } from "../utils/formatters"
import { DeleteIcon } from "./icons/DeleteIcon"
import { DownloadIcon } from "./icons/DownloadIcon"
import { EditIcon } from "./icons/EditIcon"
import { FileIcon } from "./icons/FileIcon"
import { FolderIcon } from "./icons/FolderIcon"
import { UploadIcon } from "./icons/UploadIcon"

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

const formErrorClassName =
  "hidden mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"

function FormErrorMessage() {
  return (
    <p
      data-form-error
      role="alert"
      aria-live="polite"
      className={formErrorClassName}
    ></p>
  )
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
  const folderPath = requestPath
    ? requestPath + (requestPath.endsWith("/") ? "" : "/")
    : ""
  const archiveHref = `/file/archive?path=${encodeURIComponent(requestPath)}`

  return (
    <div id="file-list-container">
      {/* パンくずリスト */}
      <nav className="mb-4 p-3 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl border border-indigo-200">
        {crumbs}
      </nav>

      {/* アクションボタン群 */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:flex">
        <button
          id="new-file-button"
          type="button"
          className="flex w-full min-w-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg border-2 border-indigo-200 bg-white px-3 py-2 text-sm font-semibold text-indigo-700 transition-all hover:border-purple-400 hover:bg-purple-50 hover:text-purple-700 sm:w-auto sm:px-4 sm:text-base"
          hx-on:click="
            const form = document.getElementById('new-file-form');
            const otherForm = document.getElementById('new-folder-form');
            const otherButton = document.getElementById('new-folder-button');
            const isHidden = form.classList.contains('hidden');
            if (isHidden) {
              form.classList.remove('hidden');
              otherForm.classList.add('hidden');
              this.classList.add('ring-2', 'ring-purple-400');
              otherButton.classList.remove('ring-2', 'ring-purple-400');
            } else {
              form.classList.add('hidden');
              this.classList.remove('ring-2', 'ring-purple-400');
            }
          "
        >
          <FileIcon />
          New File
        </button>
        <button
          id="new-folder-button"
          type="button"
          className="flex w-full min-w-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg border-none bg-gradient-to-r from-indigo-500 to-purple-500 px-3 py-2 text-sm font-semibold text-white transition-all hover:from-indigo-600 hover:to-purple-600 sm:w-auto sm:px-4 sm:text-base sm:hover:scale-105"
          hx-on:click="
            const form = document.getElementById('new-folder-form');
            const otherForm = document.getElementById('new-file-form');
            const otherButton = document.getElementById('new-file-button');
            const isHidden = form.classList.contains('hidden');
            if (isHidden) {
              form.classList.remove('hidden');
              otherForm.classList.add('hidden');
              this.classList.add('ring-2', 'ring-purple-400');
              otherButton.classList.remove('ring-2', 'ring-purple-400');
            } else {
              form.classList.add('hidden');
              this.classList.remove('ring-2', 'ring-purple-400');
            }
          "
        >
          <FolderIcon />
          New Folder
        </button>
        <a
          href={archiveHref}
          className="col-span-2 flex w-full min-w-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg border-2 border-indigo-200 bg-white px-3 py-2 text-sm font-semibold text-indigo-700 no-underline transition-all hover:border-purple-400 hover:bg-purple-50 hover:text-purple-700 sm:col-span-1 sm:w-auto sm:px-4 sm:text-base"
        >
          <DownloadIcon />
          Download Zip
        </a>
      </div>

      {/* New File フォーム（アコーディオン） */}
      <form
        id="new-file-form"
        data-inline-error-form
        hx-post="/api/file"
        hx-target="#file-list-container"
        hx-swap="innerHTML"
        className="hidden mb-4 p-4 bg-white rounded-xl border-2 border-indigo-200"
      >
        <input type="hidden" name="path" value={folderPath} />
        <input
          type="text"
          name="file"
          placeholder="New file name"
          required
          className="px-4 py-2 border-2 border-indigo-300 rounded-lg mr-2 focus:outline-none focus:border-purple-500 transition-colors"
        />
        <button
          type="submit"
          className="px-6 py-2 bg-white text-indigo-700 font-semibold border-2 border-indigo-200 rounded-lg cursor-pointer hover:border-purple-400 hover:text-purple-700 hover:bg-purple-50 transition-all"
        >
          Create File
        </button>
        <FormErrorMessage />
      </form>

      {/* New Folder フォーム（アコーディオン） */}
      <form
        id="new-folder-form"
        data-inline-error-form
        hx-post="/api/mkdir"
        hx-target="#file-list-container"
        hx-swap="innerHTML"
        className="hidden mb-4 p-4 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl border-2 border-indigo-200"
      >
        <input type="hidden" name="path" value={folderPath} />
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
        <FormErrorMessage />
      </form>

      {/* ドラッグ＆ドロップ用隠しフォーム */}
      <form
        id="drop-upload-form"
        hx-post="/api/upload"
        hx-target="#file-list-container"
        hx-swap="innerHTML"
        hx-encoding="multipart/form-data"
        className="hidden"
      >
        <input type="hidden" name="path" value={requestPath} />
        <input type="file" name="files" id="drop-upload-input" multiple />
      </form>

      {/* ファイル一覧（ドラッグ＆ドロップ対応） */}
      <div
        id="file-drop-zone"
        className="border-2 border-dashed border-transparent rounded-xl transition-all duration-200"
        hx-on:dragover="
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          this.classList.add('border-purple-500', 'bg-purple-50');
        "
        hx-on:dragleave="
          event.preventDefault();
          this.classList.remove('border-purple-500', 'bg-purple-50');
        "
        hx-on:drop={`
          event.preventDefault();
          this.classList.remove('border-purple-500', 'bg-purple-50');
          const files = event.dataTransfer.files;
          if (files.length > 0) {
            const input = document.getElementById('drop-upload-input');
            const form = document.getElementById('drop-upload-form');
            const dt = new DataTransfer();
            for (let i = 0; i < files.length; i++) {
              dt.items.add(files[i]);
            }
            input.files = dt.files;
            htmx.trigger(form, 'submit');
          }
        `}
      >
        {sortedFiles.length === 0 ? (
          <div
            className="py-12 px-4 text-center text-gray-500 cursor-pointer hover:text-indigo-600 transition-colors"
            hx-on:click="document.getElementById('drop-upload-input').click()"
          >
            <UploadIcon />
            <p className="mt-2">Drop files here to upload</p>
          </div>
        ) : (
          <ul className="list-none p-0">
            {sortedFiles.map((file) => {
              const filePath = path.join(requestPath, file.name)
              const encodedPath = encodeURIComponent(filePath)
              const renameFormId = `rename-form-${encodedPath}`
              const renameInputId = `rename-input-${encodedPath}`

              return (
                <li
                  key={file.name}
                  className="py-3 px-4 mb-2 rounded-xl border-2 border-transparent hover:border-indigo-300 hover:bg-gradient-to-r hover:from-indigo-50 hover:to-purple-50 cursor-pointer transition-all duration-200"
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
                  <div className="flex items-center justify-between gap-3">
                    {/* ファイル/ディレクトリ名リンク */}
                    <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-indigo-700 font-medium transition-colors hover:text-purple-600">
                      {file.type === "dir" ? (
                        <>
                          <span className="flex-shrink-0">
                            <FolderIcon />
                          </span>
                          <span className="break-all min-w-0">
                            {file.name}/
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="flex-shrink-0">
                            <FileIcon />
                          </span>
                          <span className="break-all min-w-0">{file.name}</span>
                        </>
                      )}
                    </span>

                    <div className="flex shrink-0 items-center gap-2 sm:gap-4">
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
                      <div
                        className="flex shrink-0 justify-end gap-2"
                        hx-on:click="event.stopPropagation()"
                      >
                        <button
                          type="button"
                          title="Rename"
                          aria-label="Rename"
                          data-rename-button
                          className="flex h-8 w-8 items-center justify-center rounded-lg border-2 border-indigo-200 bg-white px-0 text-indigo-700 transition-all hover:border-purple-400 hover:bg-purple-50 hover:text-purple-700 sm:w-auto sm:px-3 sm:font-semibold"
                          hx-on:click={`
                            event.stopPropagation();
                            const form = document.getElementById('${renameFormId}');
                            const input = document.getElementById('${renameInputId}');
                            const container = document.getElementById('file-list-container');
                            const shouldOpen = form.classList.contains('hidden');
                            container.querySelectorAll('[data-rename-form]').forEach((el) => el.classList.add('hidden'));
                            container.querySelectorAll('[data-rename-button]').forEach((el) => el.classList.remove('ring-2', 'ring-purple-400'));
                            if (shouldOpen) {
                              form.classList.remove('hidden');
                              this.classList.add('ring-2', 'ring-purple-400');
                              input.focus();
                              input.select();
                            }
                          `}
                        >
                          <span className="sm:hidden">
                            <EditIcon />
                          </span>
                          <span className="hidden sm:inline">Rename</span>
                        </button>
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
                  </div>
                  <form
                    id={renameFormId}
                    data-rename-form
                    data-inline-error-form
                    hx-post="/api/rename"
                    hx-target="#file-list-container"
                    hx-swap="innerHTML"
                    className="hidden mt-3 pt-3 border-t border-indigo-100"
                    hx-on:click="event.stopPropagation()"
                  >
                    <input type="hidden" name="path" value={filePath} />
                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        id={renameInputId}
                        type="text"
                        name="name"
                        value={file.name}
                        required
                        className="px-4 py-2 border-2 border-indigo-300 rounded-lg focus:outline-none focus:border-purple-500 transition-colors"
                      />
                      <div className="flex gap-2">
                        <button
                          type="submit"
                          className="px-4 py-2 bg-white text-indigo-700 font-semibold border-2 border-indigo-200 rounded-lg cursor-pointer hover:border-purple-400 hover:text-purple-700 hover:bg-purple-50 transition-all"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="px-4 py-2 bg-gray-100 text-gray-700 font-semibold border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-200 transition-colors"
                          hx-on:click={`
                            event.stopPropagation();
                            document.getElementById('${renameFormId}').classList.add('hidden');
                            document.querySelectorAll('[data-rename-button]').forEach((el) => el.classList.remove('ring-2', 'ring-purple-400'));
                          `}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                    <FormErrorMessage />
                  </form>
                </li>
              )
            })}
          </ul>
        )}
        {/* ドロップゾーンのヒント */}
        <div
          className="py-4 text-center text-gray-400 text-sm opacity-0 hover:opacity-100 transition-opacity cursor-pointer hover:text-indigo-600"
          hx-on:click="document.getElementById('drop-upload-input').click()"
        >
          <p>Drag and drop files here to upload</p>
        </div>
      </div>
    </div>
  )
}
