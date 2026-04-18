import * as path from "node:path"
import type { FileItem } from "../components/file-list/types"
import type { UserState } from "../types"
import { isPathTraversal } from "./pathTraversal"

export type VirtualScope = "public" | "private"

type SyntheticResult = {
	kind: "synthetic"
	entries: FileItem[]
	scope: VirtualScope | null
}

type ResolvedResult = {
	kind: "resolved"
	resolvedPath: string
	scope: VirtualScope
}

type ForbiddenResult = { kind: "forbidden" }
type NotFoundResult = { kind: "notFound" }

export type VirtualPathResult =
	| SyntheticResult
	| ResolvedResult
	| ForbiddenResult
	| NotFoundResult

const SCOPE_ROOTS: FileItem[] = [
	{ name: "public", type: "dir" as const },
	{ name: "private", type: "dir" as const },
]

export function resolveVirtualPath(
	baseDir: string,
	user: UserState,
	virtualPath: string,
): VirtualPathResult {
	if (isPathTraversal(virtualPath)) {
		return { kind: "forbidden" }
	}

	const parts = virtualPath ? virtualPath.split("/").filter(Boolean) : []

	if (parts.length === 0) {
		return { kind: "synthetic", entries: SCOPE_ROOTS, scope: null }
	}

	const scopeName = parts[0]
	if (scopeName !== "public" && scopeName !== "private") {
		return { kind: "notFound" }
	}

	const scope = scopeName as VirtualScope

	if (scope === "public") {
		return {
			kind: "resolved",
			resolvedPath: path.join(baseDir, virtualPath),
			scope,
		}
	}

	// scope === "private"
	if (user.type === "anonymous") {
		// Auth disabled: anonymous has full access to private
		return {
			kind: "resolved",
			resolvedPath: path.join(baseDir, virtualPath),
			scope,
		}
	}

	// Auth enabled
	if (parts.length === 1) {
		if (user.role === "admin") {
			return {
				kind: "resolved",
				resolvedPath: path.join(baseDir, "private"),
				scope,
			}
		}
		// Regular user: synthetic entry with their username only
		return {
			kind: "synthetic",
			entries: [{ name: user.username, type: "dir" as const }],
			scope,
		}
	}

	// private/<username>/...
	const targetUsername = parts[1]
	if (user.role !== "admin" && targetUsername !== user.username) {
		return { kind: "forbidden" }
	}

	return {
		kind: "resolved",
		resolvedPath: path.join(baseDir, virtualPath),
		scope,
	}
}

export function requireWritePermission(
	user: UserState,
	virtualPath: string,
): boolean {
	if (isPathTraversal(virtualPath)) {
		return false
	}

	if (user.type === "anonymous") {
		return true
	}

	const parts = virtualPath ? virtualPath.split("/").filter(Boolean) : []

	if (parts.length === 0) {
		return false
	}

	const scope = parts[0]

	if (scope === "public") {
		return true
	}

	if (scope === "private") {
		if (parts.length === 1) {
			return false // synthetic root — no write
		}
		if (user.role === "admin") {
			return true
		}
		return parts[1] === user.username
	}

	return false
}
