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
import { modalSurfaceClassName } from "../uiStyles"

interface FileViewerModalProps {
  fileName?: string
  path?: string
  publicUrl?: string
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
  isEditing = false,
  showEdit = false,
  showCopy = false,
  layout = "default",
  children,
}) => {
  const encodedPath = path ? encodeURIComponent(path) : ""
  const closeScript =
    "document.getElementById('file-viewer-container').innerHTML = ''; document.body.style.overflow = ''; history.pushState(null, '', '/');"

  const downloadButton = path ? (
    <a
      href={`/file/download?path=${encodedPath}`}
      download={fileName || true}
      title="Download"
      aria-label="Download"
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
      title="Open public URL"
      aria-label="Open public URL"
      className={secondaryIconButtonClassName}
    >
      <ExternalLinkIcon />
    </a>
  ) : null

  const editButton =
    path && !isEditing && showEdit ? (
      <button
        type="button"
        title="Edit"
        aria-label="Edit"
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
      title="Close"
      aria-label="Close"
      hx-on:click={closeScript}
      className={dismissIconButtonClassName}
    >
      <CloseIcon />
    </button>
  )

  const panelClassName =
    layout === "pdf"
      ? `${modalSurfaceClassName} modal-enter flex h-[92vh] max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden`
      : `${modalSurfaceClassName} modal-enter flex max-h-[80vh] w-full max-w-4xl flex-col overflow-hidden`

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
        className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
        hx-on:click={closeScript}
      >
        <div className={panelClassName} hx-on:click="event.stopPropagation();">
          <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
            <h2 className="max-w-[70%] truncate text-base font-semibold text-slate-900">
              {fileName}
            </h2>
            <div className="flex items-center gap-1">
              {downloadButton}
              {publicUrlButton}
              {copyButton}
              {editButton}
              {closeButton}
            </div>
          </div>
          <div
            className={
              layout === "pdf"
                ? "flex min-h-0 flex-1 flex-col p-4"
                : "flex min-h-0 flex-1 flex-col p-5"
            }
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
