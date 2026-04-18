import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import * as path from "node:path"
import { createTestApp } from "./helpers/createTestApp"

describe("delete", () => {
	const UPLOAD_DIR = "./tmp-test-delete"
	let app: Awaited<ReturnType<typeof createTestApp>>

	beforeEach(async () => {
		await rm(UPLOAD_DIR, { recursive: true, force: true })
		app = await createTestApp({ uploadDir: UPLOAD_DIR })
	})

	afterEach(async () => {
		await rm(UPLOAD_DIR, { recursive: true, force: true })
	})

	it("should delete a file", async () => {
		const filePath = "public/delete-me.txt"
		await Bun.write(path.join(UPLOAD_DIR, filePath), "bye")

		const formData = new FormData()
		formData.append("path", filePath)
		const res = await app.request(
			new Request("http://localhost/api/delete", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(301)
		expect(res.headers.get("location")).toBe("/?path=public")
		expect(Bun.file(path.join(UPLOAD_DIR, filePath)).text()).rejects.toThrow()
	})

	it("should delete a nested file", async () => {
		const filePath = "public/foo/bar/baz.txt"
		await mkdir(path.join(UPLOAD_DIR, "public/foo/bar"), { recursive: true })
		await Bun.write(path.join(UPLOAD_DIR, filePath), "nested")

		const formData = new FormData()
		formData.append("path", filePath)
		const res = await app.request(
			new Request("http://localhost/api/delete", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(301)
		expect(res.headers.get("location")).toBe("/?path=public/foo/bar")
		expect(Bun.file(path.join(UPLOAD_DIR, filePath)).text()).rejects.toThrow()
	})

	it("should delete an empty directory", async () => {
		const dirPath = "public/empty-dir"
		await mkdir(path.join(UPLOAD_DIR, dirPath), { recursive: true })

		const formData = new FormData()
		formData.append("path", dirPath)
		const res = await app.request(
			new Request("http://localhost/api/delete", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(301)
		expect(res.headers.get("location")).toBe("/?path=public")
		expect(Bun.file(path.join(UPLOAD_DIR, dirPath)).text()).rejects.toThrow()
	})

	it("should delete a directory with files", async () => {
		const dirPath = "public/dir-with-files"
		await mkdir(path.join(UPLOAD_DIR, dirPath), { recursive: true })
		await Bun.write(path.join(UPLOAD_DIR, dirPath, "file.txt"), "data")

		const formData = new FormData()
		formData.append("path", dirPath)
		const res = await app.request(
			new Request("http://localhost/api/delete", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(301)
		expect(res.headers.get("location")).toBe("/?path=public")
		expect(Bun.file(path.join(UPLOAD_DIR, dirPath)).text()).rejects.toThrow()
	})

	it("should return error for invalid path", async () => {
		const formData = new FormData()
		formData.append("path", "../../evil.txt")
		const res = await app.request(
			new Request("http://localhost/api/delete", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as { success: boolean; error: { name: string } }
		expect(data.success).toBe(false)
		expect(data.error.name).toBe("PathError")
	})

	it("should return error for non-existent file", async () => {
		const formData = new FormData()
		formData.append("path", "public/notfound.txt")
		const res = await app.request(
			new Request("http://localhost/api/delete", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as { success: boolean; error: { name: string } }
		expect(data.success).toBe(false)
		expect(data.error.name).toBe("FileNotFound")
	})

	it("should delete a file via htmx and return updated file list HTML", async () => {
		await Bun.write(path.join(UPLOAD_DIR, "public/delete-htmx.txt"), "delete me")
		await Bun.write(path.join(UPLOAD_DIR, "public/other.txt"), "other")

		const formData = new FormData()
		formData.append("path", "public/delete-htmx.txt")
		const res = await app.request(
			new Request("http://localhost/api/delete", {
				method: "POST",
				body: formData,
				headers: { "HX-Request": "true" },
			}),
		)
		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).toContain('id="file-list-container"')
		expect(text).toContain("other.txt")
		expect(text).not.toContain("delete-htmx.txt")
		expect(text).not.toContain("<html")
	})

	it("should delete a directory via htmx and return updated file list HTML", async () => {
		const dirPath = "public/dir-to-delete-htmx"
		await mkdir(path.join(UPLOAD_DIR, dirPath), { recursive: true })
		await Bun.write(path.join(UPLOAD_DIR, dirPath, "file.txt"), "content")

		const formData = new FormData()
		formData.append("path", dirPath)
		const res = await app.request(
			new Request("http://localhost/api/delete", {
				method: "POST",
				body: formData,
				headers: { "HX-Request": "true" },
			}),
		)
		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).toContain('id="file-list-container"')
		expect(text).not.toContain("dir-to-delete-htmx")
		expect(text).not.toContain("<html")
	})

	it("should delete a nested file via htmx and show correct parent directory", async () => {
		await mkdir(path.join(UPLOAD_DIR, "public/foo"), { recursive: true })
		await Bun.write(path.join(UPLOAD_DIR, "public/foo/htmx-delete.txt"), "del")
		await Bun.write(path.join(UPLOAD_DIR, "public/foo/sibling.txt"), "sibling")

		const formData = new FormData()
		formData.append("path", "public/foo/htmx-delete.txt")
		const res = await app.request(
			new Request("http://localhost/api/delete", {
				method: "POST",
				body: formData,
				headers: { "HX-Request": "true" },
			}),
		)
		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).toContain('id="file-list-container"')
		expect(text).toContain("sibling.txt")
		expect(text).not.toContain("htmx-delete.txt")
		expect(text).toContain("foo")
	})
})
