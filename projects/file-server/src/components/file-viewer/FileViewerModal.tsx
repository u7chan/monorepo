import type { Child, FC } from "hono/jsx"
import {
  dismissIconButtonClassName,
  secondaryIconButtonClassName,
} from "../buttonStyles"
import { CloseIcon } from "../icons/CloseIcon"
import { CopyIcon } from "../icons/CopyIcon"
import { DownloadIcon } from "../icons/DownloadIcon"
import { EditIcon } from "../icons/EditIcon"
import { ExternalLinkIcon } from "../icons/ExternalLinkIcon"

interface FileViewerModalProps {
  fileName?: string
  path?: string
  publicUrl?: string
  borderColor?: string
  animation?: string
  isEditing?: boolean
  showEdit?: boolean
  showCopy?: boolean
  layout?: "default" | "pdf"
  children: Child
}

export const FileViewerModal: FC<FileViewerModalProps> = ({
  fileName,
  path,
  publicUrl,
  borderColor = "indigo-300",
  animation,
  isEditing = false,
  showEdit = false,
  showCopy = false,
  layout = "default",
  children,
}) => {
  const encodedPath = path ? encodeURIComponent(path) : ""
  const closeScript =
    "document.getElementById('file-viewer-container').innerHTML = ''; document.body.style.overflow = 'auto'; history.pushState(null, '', '/');"

  const downloadButton = path ? (
    <a
      href={`/file/download?path=${encodedPath}`}
      download={fileName || true}
      className={secondaryIconButtonClassName}
    >
      <DownloadIcon />
    </a>
  ) : null

  const publicUrlButton = publicUrl ? (
    <a
      href={publicUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={secondaryIconButtonClassName}
    >
      <ExternalLinkIcon />
    </a>
  ) : null

  const editButton =
    path && !isEditing && showEdit ? (
      <button
        type="button"
        hx-get={`/file?path=${encodedPath}&edit=true`}
        hx-target="#file-viewer-container"
        hx-swap="outerHTML"
        className={secondaryIconButtonClassName}
      >
        <EditIcon />
      </button>
    ) : null

  const copyButton = showCopy ? (
    <button
      type="button"
      id="file-viewer-copy-button"
      title="Copy all"
      aria-label="Copy all"
      onclick="copyFileContent()"
      className={secondaryIconButtonClassName}
    >
      <CopyIcon />
    </button>
  ) : null

  const closeButton = (
    <button
      type="button"
      hx-on:click={closeScript}
      className={dismissIconButtonClassName}
    >
      <CloseIcon />
    </button>
  )

  const panelClassName =
    layout === "pdf"
      ? `bg-white p-4 sm:p-6 rounded-[1.5rem] w-full max-w-6xl h-[92vh] max-h-[92vh] overflow-hidden flex flex-col border-4 border-${borderColor} ${animation || ""}`
      : `bg-white p-6 rounded-2xl max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col border-4 border-${borderColor} ${animation || ""}`

  return (
    <div id="file-viewer-container">
      <script
        dangerouslySetInnerHTML={{
          __html: "document.body.style.overflow = 'hidden';",
        }}
      />
      {showCopy ? (
        <script
          dangerouslySetInnerHTML={{
            __html: `
            function copyFileContent() {
              const target = document.querySelector('[data-copy-source]');
              const content = target instanceof HTMLTextAreaElement ? target.value : (target?.textContent ?? '');
              async function doCopy() {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                  await navigator.clipboard.writeText(content);
                } else {
                  const textarea = document.createElement('textarea');
                  textarea.value = content;
                  textarea.style.position = 'fixed';
                  textarea.style.left = '-9999px';
                  document.body.appendChild(textarea);
                  textarea.focus();
                  textarea.select();
                  const ok = document.execCommand('copy');
                  document.body.removeChild(textarea);
                  if (!ok) throw new Error('copy failed');
                }
              }
              doCopy().then(() => showCopyFeedback('Copied')).catch(() => showCopyFeedback('Copy failed'));
            }
            let copyFeedbackTimer = null;
            let originalBtnHTML = null;
            function showCopyFeedback(message) {
              const btn = document.getElementById('file-viewer-copy-button');
              if (!btn) return;
              if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
              if (!originalBtnHTML) originalBtnHTML = btn.innerHTML;
              btn.innerHTML = '<span class=\\'text-xs font-semibold px-1\\'>' + message + '</span>';
              copyFeedbackTimer = setTimeout(function() { btn.innerHTML = originalBtnHTML; copyFeedbackTimer = null; }, 1500);
            }
          `,
          }}
        />
      ) : null}
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50"
        hx-on:click={closeScript}
      >
        <div className={panelClassName} hx-on:click="event.stopPropagation();">
          <div className="flex justify-between items-center mb-4 pb-4 border-b-2 border-indigo-200 flex-shrink-0">
            <h2 className="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent truncate max-w-[70%]">
              {fileName}
            </h2>
            <div className="flex items-center gap-2">
              {downloadButton}
              {publicUrlButton}
              {copyButton}
              {editButton}
              {closeButton}
            </div>
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}
