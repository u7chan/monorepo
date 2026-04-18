import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { createTestApp } from "./helpers/createTestApp"

const UPLOAD_DIR = "./tmp-test-create-file"
let app: Awaited<ReturnType<typeof createTestApp>>

beforeEach(async () => {
	await rm(UPLOAD_DIR, { recursive: true, force: true })
	app = await createTestApp({ uploadDir: UPLOAD_DIR })
})

afterEach(async () => {
	await rm(UPLOAD_DIR, { recursive: true, force: true })
})

describe("POST /api/file", () => {
	it("should create an empty file in the public scope", async () => {
		const body = new URLSearchParams({ path: "public", file: "new.txt" })
		const res = await app.request(
			new Request("http://localhost/api/file", {
				method: "POST",
				body,
				headers: { "content-type": "application/x-www-form-urlencoded" },
			}),
		)
		expect(res.status).toBe(301)
		expect(res.headers.get("location")).toBe("/?path=public")

		const st = await stat(join(UPLOAD_DIR, "public", "new.txt"))
		expect(st.isFile()).toBe(true)
		expect(st.size).toBe(0)
	})

	it("should create an empty file in subdirectory", async () => {
		await mkdir(join(UPLOAD_DIR, "public", "parent"))
		const body = new URLSearchParams({ path: "public/parent", file: "child.txt" })
		const res = await app.request(
			new Request("http://localhost/api/file", {
				method: "POST",
				body,
				headers: { "content-type": "application/x-www-form-urlencoded" },
			}),
		)
		expect(res.status).toBe(301)
		expect(res.headers.get("location")).toBe("/?path=public%2Fparent")

		const st = await stat(join(UPLOAD_DIR, "public", "parent", "child.txt"))
		expect(st.isFile()).toBe(true)
		expect(st.size).toBe(0)
	})

	it("should return error when trying to create existing file", async () => {
		await Bun.write(join(UPLOAD_DIR, "public", "exist.txt"), "")
		const body = new URLSearchParams({ path: "public", file: "exist.txt" })
		const res = await app.request(
			new Request("http://localhost/api/file", {
				method: "POST",
				body,
				headers: { "content-type": "application/x-www-form-urlencoded" },
			}),
		)
		expect(res.status).toBe(400)
		const json = (await res.json()) as {
			success: boolean
			error: { name: string; message: string }
		}
		expect(json.success).toBe(false)
		expect(json.error.name).toBe("AlreadyExists")
		expect(json.error.message).toBe('"exist.txt" already exists.')
	})

	it("should return error when directory with same name exists", async () => {
		await mkdir(join(UPLOAD_DIR, "public", "exist-dir"))
		const body = new URLSearchParams({ path: "public", file: "exist-dir" })
		const res = await app.request(
			new Request("http://localhost/api/file", {
				method: "POST",
				body,
				headers: { "content-type": "application/x-www-form-urlencoded" },
			}),
		)
		expect(res.status).toBe(400)
		const json = (await res.json()) as {
			success: boolean
			error: { name: string; message: string }
		}
		expect(json.success).toBe(false)
		expect(json.error.name).toBe("AlreadyExists")
	})

	it("should return error for invalid path", async () => {
		const body = new URLSearchParams({ path: "../bad", file: "test.txt" })
		const res = await app.request(
			new Request("http://localhost/api/file", {
				method: "POST",
				body,
				headers: { "content-type": "application/x-www-form-urlencoded" },
			}),
		)
		expect(res.status).toBe(400)
		const json = (await res.json()) as {
			success: boolean
			error: { name: string; message: string }
		}
		expect(json.success).toBe(false)
		expect(json.error.name).toBe("PathError")
	})

	it("should return error for invalid file name", async () => {
		for (const file of ["", ".", "..", "a/b", "a\\b"]) {
			const body = new URLSearchParams({ path: "public", file })
			const res = await app.request(
				new Request("http://localhost/api/file", {
					method: "POST",
					body,
					headers: { "content-type": "application/x-www-form-urlencoded" },
				}),
			)
			expect(res.status).toBe(400)
			const json = (await res.json()) as {
				success: boolean
				error: { name: string }
			}
			expect(json.success).toBe(false)
			expect(json.error.name).toBe("PathError")
		}
	})

	it("should create file via htmx and return HTML with updated file list", async () => {
		const body = new URLSearchParams({ path: "public", file: "htmx-new.txt" })
		const res = await app.request(
			new Request("http://localhost/api/file", {
				method: "POST",
				body,
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					"HX-Request": "true",
				},
			}),
		)
		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).toContain('id="file-list-container"')
		expect(text).toContain("htmx-new.txt")
		expect(text).not.toContain("<html")

		const st = await stat(join(UPLOAD_DIR, "public", "htmx-new.txt"))
		expect(st.isFile()).toBe(true)
		expect(st.size).toBe(0)
	})

	it("should create file in subdirectory via htmx", async () => {
		await mkdir(join(UPLOAD_DIR, "public", "htmx-parent"))
		const body = new URLSearchParams({
			path: "public/htmx-parent",
			file: "htmx-child.txt",
		})
		const res = await app.request(
			new Request("http://localhost/api/file", {
				method: "POST",
				body,
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					"HX-Request": "true",
				},
			}),
		)
		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).toContain('id="file-list-container"')
		expect(text).toContain("htmx-child.txt")
		expect(text).toContain("htmx-parent")
		expect(text).not.toContain("<html")

		const st = await stat(join(UPLOAD_DIR, "public", "htmx-parent", "htmx-child.txt"))
		expect(st.isFile()).toBe(true)
		expect(st.size).toBe(0)
	})
})
