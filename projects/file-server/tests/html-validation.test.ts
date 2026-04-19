import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import * as path from "node:path"
import {
	isPublicHtmlFile,
	isPublicScope,
	validatePublicHtml,
} from "../src/utils/htmlValidation"
import { createTestApp } from "./helpers/createTestApp"

describe("validatePublicHtml", () => {
	it("allows minimal safe HTML", () => {
		const result = validatePublicHtml(
			"<!DOCTYPE html><html><head><title>Hi</title></head><body><p>Hello</p></body></html>",
		)
		expect(result.ok).toBe(true)
	})

	it("allows safe SVG", () => {
		const result = validatePublicHtml(
			'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40" fill="red"/></svg>',
		)
		expect(result.ok).toBe(true)
	})

	it("rejects <script> tag", () => {
		const result = validatePublicHtml("<html><body><script>alert(1)</script></body></html>")
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.reason).toContain("<script>")
	})

	it("rejects <SCRIPT> (case insensitive)", () => {
		const result = validatePublicHtml("<SCRIPT>alert(1)</SCRIPT>")
		expect(result.ok).toBe(false)
	})

	it("rejects onload event handler attribute", () => {
		const result = validatePublicHtml('<body onload="alert(1)">')
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.reason).toContain("event handler attribute")
	})

	it("rejects onclick attribute", () => {
		const result = validatePublicHtml('<button onclick="alert(1)">Click</button>')
		expect(result.ok).toBe(false)
	})

	it("rejects javascript: URL", () => {
		const result = validatePublicHtml('<a href="javascript:alert(1)">link</a>')
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.reason).toContain("javascript: URL")
	})

	it("rejects javascript: with spaces", () => {
		const result = validatePublicHtml('<a href="javascript :alert(1)">link</a>')
		expect(result.ok).toBe(false)
	})

	it("rejects <iframe>", () => {
		const result = validatePublicHtml('<iframe src="https://evil.com"></iframe>')
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.reason).toContain("<iframe>")
	})

	it("rejects <object>", () => {
		const result = validatePublicHtml('<object data="evil.swf"></object>')
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.reason).toContain("<object>")
	})

	it("rejects <embed>", () => {
		const result = validatePublicHtml('<embed src="evil.swf">')
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.reason).toContain("<embed>")
	})

	it("rejects meta[http-equiv]", () => {
		const result = validatePublicHtml(
			'<meta http-equiv="refresh" content="0; url=https://evil.com">',
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.reason).toContain("meta[http-equiv]")
	})

	it("rejects <foreignObject> in SVG", () => {
		const result = validatePublicHtml(
			'<svg><foreignObject><html><body><p>hi</p></body></html></foreignObject></svg>',
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.reason).toContain("<foreignObject>")
	})

	it("returns the first matching reason", () => {
		const result = validatePublicHtml(
			'<script>alert(1)</script><body onload="x()">',
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.reason).toContain("<script>")
	})

	it("rejects javascript: via hex entity-encoded colon (&#x3a;)", () => {
		const result = validatePublicHtml('<a href="javascript&#x3a;alert(1)">link</a>')
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.reason).toContain("javascript: URL")
	})

	it("rejects javascript: via decimal entity-encoded colon (&#58;)", () => {
		const result = validatePublicHtml('<a href="javascript&#58;alert(1)">link</a>')
		expect(result.ok).toBe(false)
	})
})

describe("isPublicHtmlFile", () => {
	it.each([".html", ".htm", ".xhtml", ".svg"])("returns true for %s", (ext) => {
		expect(isPublicHtmlFile(`file${ext}`)).toBe(true)
	})

	it.each([".txt", ".png", ".pdf", ".js"])("returns false for %s", (ext) => {
		expect(isPublicHtmlFile(`file${ext}`)).toBe(false)
	})

	it("is case insensitive", () => {
		expect(isPublicHtmlFile("file.HTML")).toBe(true)
		expect(isPublicHtmlFile("file.SVG")).toBe(true)
	})
})

describe("isPublicScope", () => {
	it("returns true for 'public'", () => {
		expect(isPublicScope("public")).toBe(true)
	})

	it("returns true for paths starting with 'public/'", () => {
		expect(isPublicScope("public/foo/bar.html")).toBe(true)
	})

	it("returns false for private paths", () => {
		expect(isPublicScope("private/user/file.html")).toBe(false)
	})

	it("returns false for empty string", () => {
		expect(isPublicScope("")).toBe(false)
	})
})

describe("upload HTML/SVG validation via API", () => {
	const UPLOAD_DIR = "./tmp-test-html-validation"
	let app: Awaited<ReturnType<typeof createTestApp>>

	beforeEach(async () => {
		await rm(UPLOAD_DIR, { recursive: true, force: true })
		app = await createTestApp({ uploadDir: UPLOAD_DIR })
	})

	afterEach(async () => {
		await rm(UPLOAD_DIR, { recursive: true, force: true })
	})

	it("allows uploading safe HTML to public", async () => {
		const safeHtml =
			"<!DOCTYPE html><html><head><title>Safe</title></head><body><p>Hello</p></body></html>"
		const formData = new FormData()
		formData.append("files", new File([safeHtml], "safe.html", { type: "text/html" }))
		formData.append("path", "public")

		const res = await app.request(
			new Request("http://localhost/api/upload", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as { success: boolean; uploaded: string[] }
		expect(data.success).toBe(true)
		expect(data.uploaded).toContain("safe.html")
	})

	it("allows uploading safe SVG to public", async () => {
		const safeSvg =
			'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40" fill="blue"/></svg>'
		const formData = new FormData()
		formData.append("files", new File([safeSvg], "image.svg", { type: "image/svg+xml" }))
		formData.append("path", "public")

		const res = await app.request(
			new Request("http://localhost/api/upload", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as { success: boolean; uploaded: string[] }
		expect(data.success).toBe(true)
		expect(data.uploaded).toContain("image.svg")
	})

	it("rejects HTML with <script> to public", async () => {
		const dangerousHtml = "<html><body><script>alert(1)</script></body></html>"
		const formData = new FormData()
		formData.append("files", new File([dangerousHtml], "evil.html", { type: "text/html" }))
		formData.append("path", "public")

		const res = await app.request(
			new Request("http://localhost/api/upload", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as {
			success: boolean
			failed: { name: string; reason: string }[]
		}
		expect(data.success).toBe(false)
		expect(data.failed).toHaveLength(1)
		expect(data.failed[0].name).toBe("evil.html")
		expect(data.failed[0].reason).toContain("<script>")
	})

	it("rejects HTML with event handler to public", async () => {
		const dangerousHtml = '<body onload="alert(1)"><p>Hi</p></body>'
		const formData = new FormData()
		formData.append("files", new File([dangerousHtml], "evil.html", { type: "text/html" }))
		formData.append("path", "public")

		const res = await app.request(
			new Request("http://localhost/api/upload", { method: "POST", body: formData }),
		)
		const data = (await res.json()) as {
			success: boolean
			failed: { name: string; reason: string }[]
		}
		expect(data.success).toBe(false)
		expect(data.failed[0].reason).toContain("event handler attribute")
	})

	it("rejects SVG with <script> to public", async () => {
		const dangerousSvg =
			'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
		const formData = new FormData()
		formData.append(
			"files",
			new File([dangerousSvg], "evil.svg", { type: "image/svg+xml" }),
		)
		formData.append("path", "public")

		const res = await app.request(
			new Request("http://localhost/api/upload", { method: "POST", body: formData }),
		)
		const data = (await res.json()) as {
			success: boolean
			failed: { name: string; reason: string }[]
		}
		expect(data.success).toBe(false)
		expect(data.failed[0].reason).toContain("<script>")
	})

	it("rejects SVG with javascript: href to public", async () => {
		const dangerousSvg =
			'<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>click</text></a></svg>'
		const formData = new FormData()
		formData.append(
			"files",
			new File([dangerousSvg], "evil.svg", { type: "image/svg+xml" }),
		)
		formData.append("path", "public")

		const res = await app.request(
			new Request("http://localhost/api/upload", { method: "POST", body: formData }),
		)
		const data = (await res.json()) as {
			success: boolean
			failed: { name: string; reason: string }[]
		}
		expect(data.success).toBe(false)
		expect(data.failed[0].reason).toContain("javascript: URL")
	})

	it("rejects SVG with <foreignObject> to public", async () => {
		const dangerousSvg =
			"<svg><foreignObject><html><body><p>hi</p></body></html></foreignObject></svg>"
		const formData = new FormData()
		formData.append(
			"files",
			new File([dangerousSvg], "evil.svg", { type: "image/svg+xml" }),
		)
		formData.append("path", "public")

		const res = await app.request(
			new Request("http://localhost/api/upload", { method: "POST", body: formData }),
		)
		const data = (await res.json()) as {
			success: boolean
			failed: { name: string; reason: string }[]
		}
		expect(data.success).toBe(false)
		expect(data.failed[0].reason).toContain("<foreignObject>")
	})

	it("rejects dangerous content when path param is public/evil.svg but file.name is safe.txt", async () => {
		const dangerousSvg =
			'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
		const formData = new FormData()
		formData.append(
			"files",
			new File([dangerousSvg], "safe.txt", { type: "text/plain" }),
		)
		formData.append("path", "public/evil.svg")

		const res = await app.request(
			new Request("http://localhost/api/upload", { method: "POST", body: formData }),
		)
		const data = (await res.json()) as {
			success: boolean
			failed: { name: string; reason: string }[]
		}
		expect(data.success).toBe(false)
		expect(data.failed[0].reason).toContain("<script>")
	})

	it("rejects javascript: via HTML entity in uploaded SVG", async () => {
		const dangerousSvg = '<svg><a href="javascript&#x3a;alert(1)"><text>x</text></a></svg>'
		const formData = new FormData()
		formData.append(
			"files",
			new File([dangerousSvg], "image.svg", { type: "image/svg+xml" }),
		)
		formData.append("path", "public")

		const res = await app.request(
			new Request("http://localhost/api/upload", { method: "POST", body: formData }),
		)
		const data = (await res.json()) as {
			success: boolean
			failed: { name: string; reason: string }[]
		}
		expect(data.success).toBe(false)
		expect(data.failed[0].reason).toContain("javascript: URL")
	})

	it("does not validate HTML uploaded to private scope", async () => {
		const dangerousHtml = "<html><body><script>alert(1)</script></body></html>"
		const formData = new FormData()
		formData.append("files", new File([dangerousHtml], "evil.html", { type: "text/html" }))
		formData.append("path", "private")

		const res = await app.request(
			new Request("http://localhost/api/upload", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as { success: boolean; uploaded: string[] }
		expect(data.success).toBe(true)
		expect(data.uploaded).toContain("evil.html")
	})

	it("does not validate non-HTML files in public scope", async () => {
		const content = "alert(1)"
		const formData = new FormData()
		formData.append(
			"files",
			new File([content], "script.js", { type: "application/javascript" }),
		)
		formData.append("path", "public")

		const res = await app.request(
			new Request("http://localhost/api/upload", { method: "POST", body: formData }),
		)
		const data = (await res.json()) as { success: boolean; uploaded: string[] }
		expect(data.success).toBe(true)
		expect(data.uploaded).toContain("script.js")
	})

	it("allows one safe file and rejects one dangerous file in the same upload", async () => {
		const safeHtml = "<html><body><p>Safe</p></body></html>"
		const dangerousHtml = "<html><body><script>alert(1)</script></body></html>"
		const formData = new FormData()
		formData.append("files", new File([safeHtml], "safe.html", { type: "text/html" }))
		formData.append("files", new File([dangerousHtml], "evil.html", { type: "text/html" }))
		formData.append("path", "public")

		const res = await app.request(
			new Request("http://localhost/api/upload", { method: "POST", body: formData }),
		)
		const data = (await res.json()) as {
			success: boolean
			uploaded: string[]
			failed: { name: string; reason: string }[]
		}
		expect(data.success).toBe(false)
		expect(data.uploaded).toContain("safe.html")
		expect(data.failed).toHaveLength(1)
		expect(data.failed[0].name).toBe("evil.html")
	})
})

describe("update HTML/SVG validation via API", () => {
	const UPLOAD_DIR = "./tmp-test-html-validation-update"
	let app: Awaited<ReturnType<typeof createTestApp>>

	beforeEach(async () => {
		await rm(UPLOAD_DIR, { recursive: true, force: true })
		app = await createTestApp({ uploadDir: UPLOAD_DIR })
		await mkdir(path.join(UPLOAD_DIR, "public"), { recursive: true })
		await mkdir(path.join(UPLOAD_DIR, "private"), { recursive: true })
	})

	afterEach(async () => {
		await rm(UPLOAD_DIR, { recursive: true, force: true })
	})

	it("allows updating public HTML with safe content", async () => {
		await writeFile(path.join(UPLOAD_DIR, "public", "page.html"), "<p>Old</p>", "utf-8")

		const formData = new FormData()
		formData.append("path", "public/page.html")
		formData.append("content", "<html><body><p>Safe content</p></body></html>")

		const res = await app.request(
			new Request("http://localhost/api/update", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as { success: boolean }
		expect(data.success).toBe(true)
	})

	it("rejects updating public HTML with <script>", async () => {
		await writeFile(path.join(UPLOAD_DIR, "public", "page.html"), "<p>Old</p>", "utf-8")

		const formData = new FormData()
		formData.append("path", "public/page.html")
		formData.append("content", "<html><body><script>alert(1)</script></body></html>")

		const res = await app.request(
			new Request("http://localhost/api/update", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as { success: boolean; error: { name: string; message: string } }
		expect(data.success).toBe(false)
		expect(data.error.name).toBe("ValidationError")
		expect(data.error.message).toContain("<script>")
	})

	it("rejects updating public HTML with event handler", async () => {
		await writeFile(path.join(UPLOAD_DIR, "public", "page.html"), "<p>Old</p>", "utf-8")

		const formData = new FormData()
		formData.append("path", "public/page.html")
		formData.append("content", '<body onload="evil()"><p>Hi</p></body>')

		const res = await app.request(
			new Request("http://localhost/api/update", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as { success: boolean; error: { name: string; message: string } }
		expect(data.error.name).toBe("ValidationError")
		expect(data.error.message).toContain("event handler attribute")
	})

	it("rejects updating public SVG with javascript: URL", async () => {
		await writeFile(path.join(UPLOAD_DIR, "public", "image.svg"), "<svg></svg>", "utf-8")

		const formData = new FormData()
		formData.append("path", "public/image.svg")
		formData.append(
			"content",
			'<svg><a href="javascript:alert(1)"><text>click</text></a></svg>',
		)

		const res = await app.request(
			new Request("http://localhost/api/update", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as { success: boolean; error: { name: string; message: string } }
		expect(data.error.name).toBe("ValidationError")
		expect(data.error.message).toContain("javascript: URL")
	})

	it("rejects updating public SVG with <foreignObject>", async () => {
		await writeFile(path.join(UPLOAD_DIR, "public", "image.svg"), "<svg></svg>", "utf-8")

		const formData = new FormData()
		formData.append("path", "public/image.svg")
		formData.append(
			"content",
			"<svg><foreignObject><html><body>evil</body></html></foreignObject></svg>",
		)

		const res = await app.request(
			new Request("http://localhost/api/update", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as { success: boolean; error: { name: string; message: string } }
		expect(data.error.name).toBe("ValidationError")
		expect(data.error.message).toContain("<foreignObject>")
	})

	it("does not validate HTML in private scope", async () => {
		await mkdir(path.join(UPLOAD_DIR, "private", "user"), { recursive: true })
		await writeFile(
			path.join(UPLOAD_DIR, "private", "user", "page.html"),
			"<p>Old</p>",
			"utf-8",
		)

		const formData = new FormData()
		formData.append("path", "private/user/page.html")
		formData.append("content", "<html><body><script>alert(1)</script></body></html>")

		const res = await app.request(
			new Request("http://localhost/api/update", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as { success: boolean }
		expect(data.success).toBe(true)
	})

	it("does not validate non-HTML files in public scope", async () => {
		await writeFile(path.join(UPLOAD_DIR, "public", "script.js"), "", "utf-8")

		const formData = new FormData()
		formData.append("path", "public/script.js")
		formData.append("content", "alert(1)")

		const res = await app.request(
			new Request("http://localhost/api/update", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as { success: boolean }
		expect(data.success).toBe(true)
	})
})

describe("public HTML/SVG write restricted to admin when auth is enabled", () => {
	const UPLOAD_DIR = "./tmp-test-html-validation-role"
	const SESSION_SECRET = "0123456789abcdef0123456789abcdef"
	let app: Awaited<ReturnType<typeof createTestApp>>
	let adminCookie: string
	let userCookie: string

	beforeEach(async () => {
		await rm(UPLOAD_DIR, { recursive: true, force: true })
		app = await createTestApp({
			uploadDir: UPLOAD_DIR,
			sessionSecret: SESSION_SECRET,
			seedUsers: [
				{ username: "admin", password: "admin-pass", role: "admin" },
				{ username: "alice", password: "alice-pass", role: "user" },
			],
		})
		const { createTestSession } = await import("./helpers/auth")
		adminCookie = (await createTestSession("admin", SESSION_SECRET)).cookie
		userCookie = (await createTestSession("alice", SESSION_SECRET)).cookie
	})

	afterEach(async () => {
		await rm(UPLOAD_DIR, { recursive: true, force: true })
	})

	it("admin can upload safe HTML to public", async () => {
		const safeHtml = "<html><body><p>Hello</p></body></html>"
		const formData = new FormData()
		formData.append("files", new File([safeHtml], "page.html", { type: "text/html" }))
		formData.append("path", "public")

		const res = await app.request(
			new Request("http://localhost/api/upload", {
				method: "POST",
				body: formData,
				headers: { cookie: adminCookie },
			}),
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as { success: boolean; uploaded: string[] }
		expect(data.success).toBe(true)
		expect(data.uploaded).toContain("page.html")
	})

	it("regular user cannot upload HTML to public scope", async () => {
		const safeHtml = "<html><body><p>Hello</p></body></html>"
		const formData = new FormData()
		formData.append("files", new File([safeHtml], "page.html", { type: "text/html" }))
		formData.append("path", "public")

		const res = await app.request(
			new Request("http://localhost/api/upload", {
				method: "POST",
				body: formData,
				headers: { cookie: userCookie },
			}),
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as {
			success: boolean
			failed: { name: string; reason: string }[]
		}
		expect(data.success).toBe(false)
		expect(data.failed[0].name).toBe("page.html")
		expect(data.failed[0].reason).toContain("Only admin")
	})

	it("regular user cannot upload SVG to public scope", async () => {
		const safeSvg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>'
		const formData = new FormData()
		formData.append("files", new File([safeSvg], "image.svg", { type: "image/svg+xml" }))
		formData.append("path", "public")

		const res = await app.request(
			new Request("http://localhost/api/upload", {
				method: "POST",
				body: formData,
				headers: { cookie: userCookie },
			}),
		)
		const data = (await res.json()) as {
			success: boolean
			failed: { name: string; reason: string }[]
		}
		expect(data.success).toBe(false)
		expect(data.failed[0].reason).toContain("Only admin")
	})

	it("regular user can still upload non-HTML files to public scope", async () => {
		const formData = new FormData()
		formData.append("files", new File(["content"], "file.txt", { type: "text/plain" }))
		formData.append("path", "public")

		const res = await app.request(
			new Request("http://localhost/api/upload", {
				method: "POST",
				body: formData,
				headers: { cookie: userCookie },
			}),
		)
		const data = (await res.json()) as { success: boolean; uploaded: string[] }
		expect(data.success).toBe(true)
		expect(data.uploaded).toContain("file.txt")
	})

	it("admin can update HTML in public scope", async () => {
		const { writeFile: fsWrite, mkdir: fsMkdir } = await import("node:fs/promises")
		await fsMkdir(`${UPLOAD_DIR}/public`, { recursive: true })
		await fsWrite(`${UPLOAD_DIR}/public/page.html`, "<p>old</p>", "utf-8")

		const formData = new FormData()
		formData.append("path", "public/page.html")
		formData.append("content", "<html><body><p>Updated</p></body></html>")

		const res = await app.request(
			new Request("http://localhost/api/update", {
				method: "POST",
				body: formData,
				headers: { cookie: adminCookie },
			}),
		)
		expect(res.status).toBe(200)
	})

	it("regular user cannot update HTML in public scope", async () => {
		const { writeFile: fsWrite, mkdir: fsMkdir } = await import("node:fs/promises")
		await fsMkdir(`${UPLOAD_DIR}/public`, { recursive: true })
		await fsWrite(`${UPLOAD_DIR}/public/page.html`, "<p>old</p>", "utf-8")

		const formData = new FormData()
		formData.append("path", "public/page.html")
		formData.append("content", "<html><body><p>Hacked</p></body></html>")

		const res = await app.request(
			new Request("http://localhost/api/update", {
				method: "POST",
				body: formData,
				headers: { cookie: userCookie },
			}),
		)
		expect(res.status).toBe(403)
		const data = (await res.json()) as { success: boolean; error: { name: string } }
		expect(data.error.name).toBe("Forbidden")
	})

	it("regular user cannot rename file to HTML in public scope", async () => {
		const { writeFile: fsWrite, mkdir: fsMkdir } = await import("node:fs/promises")
		await fsMkdir(`${UPLOAD_DIR}/public`, { recursive: true })
		await fsWrite(`${UPLOAD_DIR}/public/page.txt`, "<p>content</p>", "utf-8")

		const formData = new FormData()
		formData.append("path", "public/page.txt")
		formData.append("name", "page.html")

		const res = await app.request(
			new Request("http://localhost/api/rename", {
				method: "POST",
				body: formData,
				headers: { cookie: userCookie },
			}),
		)
		expect(res.status).toBe(403)
		const data = (await res.json()) as { success: boolean; error: { name: string } }
		expect(data.error.name).toBe("Forbidden")
	})
})

describe("rename HTML/SVG validation via API", () => {
	const UPLOAD_DIR = "./tmp-test-html-validation-rename"
	let app: Awaited<ReturnType<typeof createTestApp>>

	beforeEach(async () => {
		await rm(UPLOAD_DIR, { recursive: true, force: true })
		app = await createTestApp({ uploadDir: UPLOAD_DIR })
		await mkdir(path.join(UPLOAD_DIR, "public"), { recursive: true })
	})

	afterEach(async () => {
		await rm(UPLOAD_DIR, { recursive: true, force: true })
	})

	it("allows renaming safe content to public HTML", async () => {
		await writeFile(
			path.join(UPLOAD_DIR, "public", "page.txt"),
			"<html><body><p>Safe</p></body></html>",
			"utf-8",
		)

		const formData = new FormData()
		formData.append("path", "public/page.txt")
		formData.append("name", "page.html")

		const res = await app.request(
			new Request("http://localhost/api/rename", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(301)
	})

	it("rejects renaming file with <script> content to public HTML", async () => {
		await writeFile(
			path.join(UPLOAD_DIR, "public", "evil.txt"),
			"<html><body><script>alert(1)</script></body></html>",
			"utf-8",
		)

		const formData = new FormData()
		formData.append("path", "public/evil.txt")
		formData.append("name", "evil.html")

		const res = await app.request(
			new Request("http://localhost/api/rename", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as { success: boolean; error: { name: string; message: string } }
		expect(data.error.name).toBe("ValidationError")
		expect(data.error.message).toContain("<script>")
	})

	it("rejects renaming file with javascript: content to public SVG", async () => {
		await writeFile(
			path.join(UPLOAD_DIR, "public", "evil.txt"),
			'<svg><a href="javascript:alert(1)"><text>x</text></a></svg>',
			"utf-8",
		)

		const formData = new FormData()
		formData.append("path", "public/evil.txt")
		formData.append("name", "evil.svg")

		const res = await app.request(
			new Request("http://localhost/api/rename", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as { success: boolean; error: { name: string; message: string } }
		expect(data.error.name).toBe("ValidationError")
	})

	it("does not validate when renaming to non-HTML extension", async () => {
		await writeFile(
			path.join(UPLOAD_DIR, "public", "old.html"),
			"<script>alert(1)</script>",
			"utf-8",
		)

		const formData = new FormData()
		formData.append("path", "public/old.html")
		formData.append("name", "old.txt")

		const res = await app.request(
			new Request("http://localhost/api/rename", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(301)
	})
})
