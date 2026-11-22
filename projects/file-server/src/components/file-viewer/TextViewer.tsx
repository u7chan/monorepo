import type { FC } from "hono/jsx"
import { TEXT_EXCERPT_BYTES } from "../../utils/filePreviewLimits"
import { formatFileSize } from "../../utils/formatters"
import { compactSecondaryButtonClassName } from "../buttonStyles"

interface TextViewerProps {
  content: string
  /** Total file size when `content` is only the head of a larger file. */
  truncatedFileSize?: number
  /** Whole file rendered in a new tab. Omitted for active content. */
  fullTextUrl?: string
}

export const TextViewer: FC<TextViewerProps> = ({
  content,
  truncatedFileSize,
  fullTextUrl,
}) => {
  if (content.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-lg bg-slate-50 p-6 text-center text-sm text-slate-400">
        This file is empty.
        <span data-copy-source style="display:none" />
      </div>
    )
  }

  // Why keep the notice outside the scroll container: the excerpt can be long
  // enough to scroll, and the warning must never scroll out of view.
  const truncationNotice =
    truncatedFileSize === undefined ? null : (
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 pb-3 text-sm text-slate-600">
        <p className="min-w-0 flex-1">
          This file is {formatFileSize(truncatedFileSize)}, so only the first{" "}
          {formatFileSize(TEXT_EXCERPT_BYTES)} is shown. Editing and copying are
          disabled for files this large.
        </p>
        {fullTextUrl && (
          <a
            href={fullTextUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={compactSecondaryButtonClassName}
          >
            Open full text
          </a>
        )}
      </div>
    )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {truncationNotice}
      <pre
        data-copy-source
        className="flex-1 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-4 font-mono text-sm text-slate-800"
      >
        {content}
      </pre>
    </div>
  )
}
