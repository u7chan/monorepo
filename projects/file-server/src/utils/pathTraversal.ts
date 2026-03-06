import path from "node:path"

export function isPathTraversal(p: string): boolean {
	if (!p) {
		return false
	}

	const normalized = path.posix.normalize(p.replaceAll("\\", "/"))
	const hasParentReference =
		normalized === ".." ||
		normalized.startsWith("../") ||
		normalized.includes("/../") ||
		normalized.endsWith("/..")

	return (
		hasParentReference ||
		path.posix.isAbsolute(normalized) ||
		path.win32.isAbsolute(p)
	)
}
