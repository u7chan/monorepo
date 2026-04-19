import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import * as path from "node:path"
import { createTestApp } from "./helpers/createTestApp"
import { createTestSession } from "./helpers/auth"

const SESSION_SECRET = "test-secret-for-raw-download"

describe("GET /file/raw - active content blocking", () => {
	const UPLOAD_DIR = "./tmp-test-raw-block"
	let app: Awaited<ReturnType<typeof createTestApp>>

	beforeEach(async () => {
		await rm(UPLOAD_DIR, { recursive: true, force: true })
		app = await createTestApp({ uploadDir: UPLOAD_DIR })
	})

	afterEach(async () => {
		await rm(UPLOAD_DIR, { recursive: true, force: true })
	})

	it("should return 403 for HTML file in public", async () => {
		await Bun.write(
			path.join(UPLOAD_DIR, "public", "page.html"),
			"<html><body>hello</body></html>",
		)
		const res = await app.request(
			new Request("http://localhost/file/raw?path=public%2Fpage.html"),
		)
		expect(res.status).toBe(403)
		const data = (await res.json()) as { error: { name: string } }
		expect(data.error.name).toBe("ActiveContentNotAllowed")
	})

	it("should return 403 for .htm file", async () => {
		await Bun.write(
			path.join(UPLOAD_DIR, "public", "page.htm"),
			"<html>hello</html>",
		)
		const res = await app.request(
			new Request("http://localhost/file/raw?path=public%2Fpage.htm"),
		)
		expect(res.status).toBe(403)
		const data = (await res.json()) as { error: { name: string } }
		expect(data.error.name).toBe("ActiveContentNotAllowed")
	})

	it("should return 403 for .xhtml file", async () => {
		await Bun.write(
			path.join(UPLOAD_DIR, "public", "page.xhtml"),
			'<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"></html>',
		)
		const res = await app.request(
			new Request("http://localhost/file/raw?path=public%2Fpage.xhtml"),
		)
		expect(res.status).toBe(403)
		const data = (await res.json()) as { error: { name: string } }
		expect(data.error.name).toBe("ActiveContentNotAllowed")
	})

	it("should return 403 for SVG file", async () => {
		await Bun.write(
			path.join(UPLOAD_DIR, "public", "image.svg"),
			'<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>',
		)
		const res = await app.request(
			new Request("http://localhost/file/raw?path=public%2Fimage.svg"),
		)
		expect(res.status).toBe(403)
		const data = (await res.json()) as { error: { name: string } }
		expect(data.error.name).toBe("ActiveContentNotAllowed")
	})

	it("should serve PNG image without block", async () => {
		const pngBytes = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		])
		await Bun.write(path.join(UPLOAD_DIR, "public", "image.png"), pngBytes)
		const res = await app.request(
			new Request("http://localhost/file/raw?path=public%2Fimage.png"),
		)
		expect(res.status).toBe(200)
		expect(res.headers.get("Content-Type")).toContain("image/png")
	})

	it("should serve text file without block", async () => {
		await Bun.write(path.join(UPLOAD_DIR, "public", "note.txt"), "hello world")
		const res = await app.request(
			new Request("http://localhost/file/raw?path=public%2Fnote.txt"),
		)
		expect(res.status).toBe(200)
	})

	it("should return 403 for HTML in private dir (auth disabled)", async () => {
		await mkdir(path.join(UPLOAD_DIR, "private"), { recursive: true })
		await Bun.write(
			path.join(UPLOAD_DIR, "private", "secret.html"),
			"<html>secret</html>",
		)
		const res = await app.request(
			new Request("http://localhost/file/raw?path=private%2Fsecret.html"),
		)
		expect(res.status).toBe(403)
		const data = (await res.json()) as { error: { name: string } }
		expect(data.error.name).toBe("ActiveContentNotAllowed")
	})
})

describe("GET /file/raw - active content blocking with auth", () => {
	const UPLOAD_DIR = "./tmp-test-raw-block-auth"
	let app: Awaited<ReturnType<typeof createTestApp>>

	beforeEach(async () => {
		await rm(UPLOAD_DIR, { recursive: true, force: true })
		app = await createTestApp({
			uploadDir: UPLOAD_DIR,
			sessionSecret: SESSION_SECRET,
			seedUsers: [
				{ username: "admin", password: "pass", role: "admin" },
				{ username: "alice", password: "pass", role: "user" },
			],
		})
	})

	afterEach(async () => {
		await rm(UPLOAD_DIR, { recursive: true, force: true })
	})

	it("should return 403 for SVG in private dir even with valid session", async () => {
		const session = await createTestSession("alice", SESSION_SECRET)
		await mkdir(path.join(UPLOAD_DIR, "private", "alice"), { recursive: true })
		await Bun.write(
			path.join(UPLOAD_DIR, "private", "alice", "chart.svg"),
			'<svg xmlns="http://www.w3.org/2000/svg"></svg>',
		)
		const res = await app.request(
			new Request(
				"http://localhost/file/raw?path=private%2Falice%2Fchart.svg",
				{ headers: { Cookie: session.cookie } },
			),
		)
		expect(res.status).toBe(403)
		const data = (await res.json()) as { error: { name: string } }
		expect(data.error.name).toBe("ActiveContentNotAllowed")
	})

	it("should deny access to other user private file (403 Forbidden)", async () => {
		const session = await createTestSession("alice", SESSION_SECRET)
		await mkdir(path.join(UPLOAD_DIR, "private", "admin"), { recursive: true })
		await Bun.write(
			path.join(UPLOAD_DIR, "private", "admin", "secret.png"),
			new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
		)
		const res = await app.request(
			new Request(
				"http://localhost/file/raw?path=private%2Fadmin%2Fsecret.png",
				{ headers: { Cookie: session.cookie } },
			),
		)
		expect(res.status).toBe(403)
	})
})

describe("GET /file/download", () => {
	const UPLOAD_DIR = "./tmp-test-download"
	let app: Awaited<ReturnType<typeof createTestApp>>

	beforeEach(async () => {
		await rm(UPLOAD_DIR, { recursive: true, force: true })
		app = await createTestApp({ uploadDir: UPLOAD_DIR })
	})

	afterEach(async () => {
		await rm(UPLOAD_DIR, { recursive: true, force: true })
	})

	it("should download HTML file with attachment disposition", async () => {
		await Bun.write(
			path.join(UPLOAD_DIR, "public", "page.html"),
			"<html><body>hello</body></html>",
		)
		const res = await app.request(
			new Request("http://localhost/file/download?path=public%2Fpage.html"),
		)
		expect(res.status).toBe(200)
		const disposition = res.headers.get("Content-Disposition")
		expect(disposition).toContain("attachment")
		expect(disposition).toContain("page.html")
	})

	it("should download SVG file with attachment disposition", async () => {
		await Bun.write(
			path.join(UPLOAD_DIR, "public", "image.svg"),
			'<svg xmlns="http://www.w3.org/2000/svg"></svg>',
		)
		const res = await app.request(
			new Request("http://localhost/file/download?path=public%2Fimage.svg"),
		)
		expect(res.status).toBe(200)
		const disposition = res.headers.get("Content-Disposition")
		expect(disposition).toContain("attachment")
		expect(disposition).toContain("image.svg")
	})

	it("should download PNG file with attachment disposition", async () => {
		const pngBytes = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		])
		await Bun.write(path.join(UPLOAD_DIR, "public", "photo.png"), pngBytes)
		const res = await app.request(
			new Request("http://localhost/file/download?path=public%2Fphoto.png"),
		)
		expect(res.status).toBe(200)
		const disposition = res.headers.get("Content-Disposition")
		expect(disposition).toContain("attachment")
		expect(disposition).toContain("photo.png")
	})

	it("should download text file with attachment disposition", async () => {
		await Bun.write(
			path.join(UPLOAD_DIR, "public", "note.txt"),
			"some text content",
		)
		const res = await app.request(
			new Request("http://localhost/file/download?path=public%2Fnote.txt"),
		)
		expect(res.status).toBe(200)
		const disposition = res.headers.get("Content-Disposition")
		expect(disposition).toContain("attachment")
		expect(disposition).toContain("note.txt")
	})

	it("should return 400 for non-existent file", async () => {
		const res = await app.request(
			new Request("http://localhost/file/download?path=public%2Fnotfound.bin"),
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as { error: { name: string } }
		expect(data.error.name).toBe("NotFound")
	})

	it("should return 400 for directory path", async () => {
		await mkdir(path.join(UPLOAD_DIR, "public", "subdir"), { recursive: true })
		const res = await app.request(
			new Request("http://localhost/file/download?path=public%2Fsubdir"),
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as { error: { name: string } }
		expect(data.error.name).toBe("NotAFile")
	})

	it("should reject path traversal", async () => {
		const res = await app.request(
			new Request("http://localhost/file/download?path=../secret"),
		)
		expect(res.status).toBe(403)
		const data = (await res.json()) as { error: { name: string } }
		expect(data.error.name).toBe("Forbidden")
	})
})

describe("GET /file/download - with auth", () => {
	const UPLOAD_DIR = "./tmp-test-download-auth"
	let app: Awaited<ReturnType<typeof createTestApp>>

	beforeEach(async () => {
		await rm(UPLOAD_DIR, { recursive: true, force: true })
		app = await createTestApp({
			uploadDir: UPLOAD_DIR,
			sessionSecret: SESSION_SECRET,
			seedUsers: [
				{ username: "admin", password: "pass", role: "admin" },
				{ username: "alice", password: "pass", role: "user" },
			],
		})
	})

	afterEach(async () => {
		await rm(UPLOAD_DIR, { recursive: true, force: true })
	})

	it("should allow user to download own private file", async () => {
		const session = await createTestSession("alice", SESSION_SECRET)
		await mkdir(path.join(UPLOAD_DIR, "private", "alice"), { recursive: true })
		await Bun.write(
			path.join(UPLOAD_DIR, "private", "alice", "report.html"),
			"<html>report</html>",
		)
		const res = await app.request(
			new Request(
				"http://localhost/file/download?path=private%2Falice%2Freport.html",
				{ headers: { Cookie: session.cookie } },
			),
		)
		expect(res.status).toBe(200)
		const disposition = res.headers.get("Content-Disposition")
		expect(disposition).toContain("attachment")
		expect(disposition).toContain("report.html")
	})

	it("should deny download of other user private file", async () => {
		const session = await createTestSession("alice", SESSION_SECRET)
		await mkdir(path.join(UPLOAD_DIR, "private", "admin"), { recursive: true })
		await Bun.write(
			path.join(UPLOAD_DIR, "private", "admin", "secret.txt"),
			"top secret",
		)
		const res = await app.request(
			new Request(
				"http://localhost/file/download?path=private%2Fadmin%2Fsecret.txt",
				{ headers: { Cookie: session.cookie } },
			),
		)
		expect(res.status).toBe(403)
	})
})

describe("GET /file - viewer routing regression", () => {
	const UPLOAD_DIR = "./tmp-test-file-viewer-regression"
	let app: Awaited<ReturnType<typeof createTestApp>>

	beforeEach(async () => {
		await rm(UPLOAD_DIR, { recursive: true, force: true })
		app = await createTestApp({ uploadDir: UPLOAD_DIR })
	})

	afterEach(async () => {
		await rm(UPLOAD_DIR, { recursive: true, force: true })
	})

	it("should render SVG as source view (text viewer), not image viewer", async () => {
		await Bun.write(
			path.join(UPLOAD_DIR, "public", "chart.svg"),
			'<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>',
		)
		const res = await app.request(
			new Request("http://localhost/file?path=public%2Fchart.svg", {
				headers: { "HX-Request": "true" },
			}),
		)
		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).toMatch(/<pre[^>]*>/)
		expect(text).not.toContain("<img")
	})

	it("should render HTML as source view (text viewer), not image viewer", async () => {
		await Bun.write(
			path.join(UPLOAD_DIR, "public", "page.html"),
			"<html><body>hello</body></html>",
		)
		const res = await app.request(
			new Request("http://localhost/file?path=public%2Fpage.html", {
				headers: { "HX-Request": "true" },
			}),
		)
		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).toMatch(/<pre[^>]*>/)
		expect(text).not.toContain("<img")
	})

	it("should render PNG as image viewer, not source view", async () => {
		const pngBytes = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		])
		await Bun.write(path.join(UPLOAD_DIR, "public", "photo.png"), pngBytes)
		const res = await app.request(
			new Request("http://localhost/file?path=public%2Fphoto.png", {
				headers: { "HX-Request": "true" },
			}),
		)
		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).toContain("<img")
		expect(text).not.toMatch(/<pre[^>]*>/)
	})

	it("should render PDF as PDF viewer (iframe), not source view", async () => {
		await Bun.write(
			path.join(UPLOAD_DIR, "public", "doc.pdf"),
			"%PDF-1.4 fake pdf content",
		)
		const res = await app.request(
			new Request("http://localhost/file?path=public%2Fdoc.pdf", {
				headers: { "HX-Request": "true" },
			}),
		)
		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).toContain("<iframe")
		expect(text).not.toMatch(/<pre[^>]*>/)
	})
})
