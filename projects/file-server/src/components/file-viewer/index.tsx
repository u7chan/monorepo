import type { FC } from "hono/jsx"
import { DefaultViewer } from "./DefaultViewer"
import { FileViewerModal } from "./FileViewerModal"
import { ImageViewer } from "./ImageViewer"
import { PdfViewer } from "./PdfViewer"
import { TextEditor } from "./TextEditor"
import { TextViewer } from "./TextViewer"
import { VideoViewer } from "./VideoViewer"

interface FileViewerProps {
  content?: string
  mimeType?: string
  fileName?: string
  path?: string
  isEditing?: boolean
  allowEdit?: boolean
  publicUrl?: string
}

export const FileViewer: FC<FileViewerProps> = ({
  content,
  mimeType,
  fileName,
  path,
  isEditing = false,
  allowEdit = true,
  publicUrl,
}) => {
  const encodedPath = path ? encodeURIComponent(path) : ""
  const fileUrl = `/file/raw?path=${encodedPath}`

  // テキストファイルの場合
  if (content !== undefined) {
    if (isEditing && path) {
      return (
        <FileViewerModal
          fileName={fileName}
          path={path}
          publicUrl={publicUrl}
          borderColor="indigo-300"
          isEditing={true}
          showEdit={allowEdit}
        >
          <TextEditor content={content} path={path} />
        </FileViewerModal>
      )
    }
    return (
      <FileViewerModal
        fileName={fileName}
        path={path}
        publicUrl={publicUrl}
        borderColor="indigo-300"
        showEdit={allowEdit}
      >
        <TextViewer content={content} />
      </FileViewerModal>
    )
  }

  // バイナリファイルの場合
  if (mimeType) {
    // 画像ファイル
    if (mimeType.startsWith("image/")) {
      return (
        <FileViewerModal
          fileName={fileName}
          path={path}
          borderColor="purple-300"
        >
          <ImageViewer fileUrl={fileUrl} fileName={fileName} />
        </FileViewerModal>
      )
    }

    // 動画ファイル
    if (mimeType.startsWith("video/")) {
      return (
        <FileViewerModal fileName={fileName} path={path} borderColor="pink-300">
          <VideoViewer fileUrl={fileUrl} mimeType={mimeType} />
        </FileViewerModal>
      )
    }

    // PDFファイル
    if (mimeType === "application/pdf") {
      return (
        <FileViewerModal
          fileName={fileName}
          path={path}
          borderColor="indigo-300"
          layout="pdf"
        >
          <PdfViewer fileUrl={fileUrl} fileName={fileName} />
        </FileViewerModal>
      )
    }
  }

  // デフォルト表示
  return (
    <FileViewerModal
      fileName={fileName}
      path={path}
      borderColor="purple-300"
      animation="animate-[slideIn_0.2s_ease-out]"
    >
      <DefaultViewer path={path} />
    </FileViewerModal>
  )
}
