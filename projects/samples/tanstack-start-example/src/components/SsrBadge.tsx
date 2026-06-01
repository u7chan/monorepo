export function SsrBadge({ renderedAt }: { renderedAt: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 font-mono text-xs">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
      SSR · Rendered at {renderedAt}
    </span>
  )
}
