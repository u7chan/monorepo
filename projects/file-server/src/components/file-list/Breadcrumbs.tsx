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
      <span key={`${crumb.label}:${crumb.path}`}>
        <a
          href={href}
          hx-get={hxGet}
          hx-target="#file-list-container"
          hx-push-url={href}
          className="text-indigo-600 font-semibold no-underline hover:text-purple-600 transition-colors mx-1"
        >
          {crumb.label}
        </a>
        {!isLast ? " / " : ""}
      </span>
    )
  })
}

export function Breadcrumbs({ breadcrumbs }: BreadcrumbsProps) {
  return (
    <nav className="mb-4 p-3 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl border border-indigo-200">
      {buildBreadcrumbs(breadcrumbs)}
    </nav>
  )
}
