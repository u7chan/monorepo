import { formatTagDateTime } from "../../lib/tagDateTime";
import type { ImageUpdate } from "../../types/container";

/**
 * 稼働中より新しいビルドがあることを示す印。Deploy を開けばタグと日時を選べるため、
 * ここでは色と短いラベルだけを添え、操作は Deploy に任せる。
 */
export function ImageUpdateBadge({ update }: { update: ImageUpdate }) {
  const builtAt = formatTagDateTime(update.createdAt);
  const description = builtAt
    ? `A newer image (${update.latestTag}) was built at ${builtAt} (JST).`
    : `A newer image (${update.latestTag}) is available.`;

  return (
    <span
      title={description}
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-fill px-2 py-0.5 text-caption font-semibold text-info"
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-info" />
      New
      <span className="sr-only"> image available</span>
    </span>
  );
}
