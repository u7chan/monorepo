import { breadcrumbLinkClassName, mutedTextClassName } from "../uiStyles"
import type { BrowseCrumb } from "./types"

interface BreadcrumbsProps {
  breadcrumbs: BrowseCrumb[]
}

function buildBrowseHref(path: string): string {
  return path ? `/?path=${encodeURIComponent(path)}` : "/"
}

function buildBreadcrumbs(breadcrumbs: BrowseCrumb[]) {
  return breadcrumbs.map((crumb, idx) => {
    const isLast = idx === breadcrumbs.length - 1
    const href = buildBrowseHref(crumb.path)
    const hxGet = `/browse?path=${encodeURIComponent(crumb.path)}`

    return (
      <span key={`${crumb.label}:${crumb.path}`} className="flex items-center">
        {idx > 0 && <span className="text-slate-300">/</span>}
        <a
          href={href}
          hx-get={hxGet}
          hx-target="#file-list-container"
          hx-push-url={href}
          aria-current={isLast ? "page" : undefined}
          className={
            isLast ? "px-1 font-medium text-slate-900" : breadcrumbLinkClassName
          }
        >
          {crumb.label}
        </a>
      </span>
    )
  })
}

export function Breadcrumbs({ breadcrumbs }: BreadcrumbsProps) {
  return (
    <nav
      aria-label="Breadcrumb"
      className={`flex flex-wrap items-center gap-y-1 ${mutedTextClassName}`}
    >
      {buildBreadcrumbs(breadcrumbs)}
    </nav>
  )
}
