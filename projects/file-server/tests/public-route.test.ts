import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { createTestApp } from "./helpers/createTestApp"

const UPLOAD_DIR = "./tmp-test-public-route"
let app: Awaited<ReturnType<typeof createTestApp>>

beforeEach(async () => {
	await rm(UPLOAD_DIR, { recursive: true, force: true })
	app = await createTestApp({ uploadDir: UPLOAD_DIR })
})

afterEach(async () => {
	await rm(UPLOAD_DIR, { recursive: true, force: true })
})

describe("GET /public/*", () => {
	it("serves a text file without authentication", async () => {
		await writeFile(path.join(UPLOAD_DIR, "public", "hello.txt"), "Hello Public!")

		const res = await app.request(new Request("http://localhost/public/hello.txt"))

		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toContain("text/plain")
		expect(await res.text()).toBe("Hello Public!")
	})

	it("serves a PNG image", async () => {
		const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47])
		await writeFile(path.join(UPLOAD_DIR, "public", "image.png"), pngHeader)

		const res = await app.request(new Request("http://localhost/public/image.png"))

		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toContain("image/png")
	})

	it("serves a PDF file", async () => {
		await writeFile(path.join(UPLOAD_DIR, "public", "doc.pdf"), "%PDF-1.4")

		const res = await app.request(new Request("http://localhost/public/doc.pdf"))

		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toContain("application/pdf")
	})

	it("serves a file in a subdirectory", async () => {
		await mkdir(path.join(UPLOAD_DIR, "public", "sub"), { recursive: true })
		await writeFile(path.join(UPLOAD_DIR, "public", "sub", "nested.txt"), "Nested content")

		const res = await app.request(new Request("http://localhost/public/sub/nested.txt"))

		expect(res.status).toBe(200)
		expect(await res.text()).toBe("Nested content")
	})

	it("returns 404 for missing file", async () => {
		const res = await app.request(new Request("http://localhost/public/nonexistent.txt"))

		expect(res.status).toBe(404)
		const body = (await res.json()) as { success: boolean; error: { name: string } }
		expect(body.success).toBe(false)
		expect(body.error.name).toBe("NotFound")
	})

	it("returns 404 when path is empty", async () => {
		const res = await app.request(new Request("http://localhost/public/"))

		expect(res.status).toBe(404)
	})

	it("blocks Windows-style path traversal attempt", async () => {
		// Windows backslash traversal: handler normalizes ..\ to detect traversal
		const res = await app.request(
			new Request("http://localhost/public/..\\..\\etc\\passwd"),
		)

		// Hono or handler blocks this (403 or 404 — either is acceptable; the file is not served)
		expect(res.status).not.toBe(200)
	})

	it("blocks HTML files with 403", async () => {
		await writeFile(path.join(UPLOAD_DIR, "public", "page.html"), "<html></html>")

		const res = await app.request(new Request("http://localhost/public/page.html"))

		expect(res.status).toBe(403)
		const body = (await res.json()) as { success: boolean; error: { name: string } }
		expect(body.success).toBe(false)
		expect(body.error.name).toBe("ActiveContentNotAllowed")
	})

	it("blocks HTM files with 403", async () => {
		await writeFile(path.join(UPLOAD_DIR, "public", "page.htm"), "<html></html>")

		const res = await app.request(new Request("http://localhost/public/page.htm"))

		expect(res.status).toBe(403)
	})

	it("blocks SVG files with 403", async () => {
		await writeFile(
			path.join(UPLOAD_DIR, "public", "image.svg"),
			"<svg xmlns='http://www.w3.org/2000/svg'/>",
		)

		const res = await app.request(new Request("http://localhost/public/image.svg"))

		expect(res.status).toBe(403)
	})

	it("returns 404 when path is a directory", async () => {
		await mkdir(path.join(UPLOAD_DIR, "public", "mydir"), { recursive: true })

		const res = await app.request(new Request("http://localhost/public/mydir"))

		expect(res.status).toBe(404)
	})

	it("is accessible without a session cookie when auth is enabled", async () => {
		const USERS_FILE = path.join(UPLOAD_DIR, "users.json")
		await writeFile(
			USERS_FILE,
			JSON.stringify([
				{
					username: "alice",
					passwordHash: await Bun.password.hash("pw", {
						algorithm: "bcrypt",
						cost: 4,
					}),
					role: "user",
				},
			]),
		)
		app = await createTestApp({
			uploadDir: UPLOAD_DIR,
			usersFile: USERS_FILE,
			sessionSecret: "0123456789abcdef0123456789abcdef",
		})

		await writeFile(path.join(UPLOAD_DIR, "public", "open.txt"), "public content")

		const res = await app.request(
			new Request("http://localhost/public/open.txt"),
		)

		expect(res.status).toBe(200)
		expect(await res.text()).toBe("public content")
	})
})
