import * as path from "node:path"

const PUBLIC_HTML_EXTENSIONS = new Set([".html", ".htm", ".xhtml", ".svg"])

export function isPublicHtmlFile(fileName: string): boolean {
	const ext = path.extname(fileName).toLowerCase()
	return PUBLIC_HTML_EXTENSIONS.has(ext)
}

export function isPublicScope(virtualPath: string): boolean {
	return virtualPath === "public" || virtualPath.startsWith("public/")
}

export type HtmlValidationResult = { ok: true } | { ok: false; reason: string }

const DENIED_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
	{ pattern: /<script\b/i, label: "<script>" },
	{ pattern: /\bon\w+\s*=/i, label: "event handler attribute" },
	{ pattern: /javascript\s*:/i, label: "javascript: URL" },
	{ pattern: /<iframe\b/i, label: "<iframe>" },
	{ pattern: /<object\b/i, label: "<object>" },
	{ pattern: /<embed\b/i, label: "<embed>" },
	{ pattern: /<meta[^>]+http-equiv/i, label: "meta[http-equiv]" },
	{ pattern: /<foreignObject\b/i, label: "<foreignObject>" },
]

function decodeHtmlEntities(content: string): string {
	return content
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
			String.fromCodePoint(Number.parseInt(hex, 16)),
		)
		.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
}

export function validatePublicHtml(content: string): HtmlValidationResult {
	const decoded = decodeHtmlEntities(content)
	for (const { pattern, label } of DENIED_PATTERNS) {
		if (pattern.test(content) || pattern.test(decoded)) {
			return { ok: false, reason: `Prohibited content: ${label}` }
		}
	}
	return { ok: true }
}
