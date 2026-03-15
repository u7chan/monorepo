interface BreadcrumbsProps {
	requestPath: string
}

function buildBreadcrumbs(requestPath: string) {
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

export function Breadcrumbs({ requestPath }: BreadcrumbsProps) {
	return (
		<nav className="mb-4 p-3 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl border border-indigo-200">
			{buildBreadcrumbs(requestPath)}
		</nav>
	)
}
