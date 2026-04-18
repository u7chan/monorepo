import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { createTestApp } from "./helpers/createTestApp"

describe("update", () => {
	const UPLOAD_DIR = "./tmp-test-update"
	let app: Awaited<ReturnType<typeof createTestApp>>

	beforeEach(async () => {
		await rm(UPLOAD_DIR, { recursive: true, force: true })
		app = await createTestApp({ uploadDir: UPLOAD_DIR })
	})

	afterEach(async () => {
		await rm(UPLOAD_DIR, { recursive: true, force: true })
	})

	it("should update a text file via API", async () => {
		const testFilePath = path.join(UPLOAD_DIR, "public", "test-update.txt")
		await writeFile(testFilePath, "Initial content", "utf-8")

		const formData = new FormData()
		formData.append("path", "public/test-update.txt")
		formData.append("content", "Updated content!")

		const res = await app.request(
			new Request("http://localhost/api/update", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as { success: boolean }
		expect(data.success).toBe(true)

		const saved = await readFile(testFilePath, "utf-8")
		expect(saved).toBe("Updated content!")
	})

	it("should update a text file via htmx and return HTML", async () => {
		const testFilePath = path.join(UPLOAD_DIR, "public", "htmx-update.txt")
		await writeFile(testFilePath, "Initial htmx content", "utf-8")

		const formData = new FormData()
		formData.append("path", "public/htmx-update.txt")
		formData.append("content", "Updated via htmx!")

		const res = await app.request(
			new Request("http://localhost/api/update", {
				method: "POST",
				body: formData,
				headers: { "HX-Request": "true" },
			}),
		)
		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).toContain("htmx-update.txt")
		expect(text).toContain("Updated via htmx!")
		expect(text).toContain('id="file-viewer-container"')
		expect(text).not.toContain("<html")

		const saved = await readFile(testFilePath, "utf-8")
		expect(saved).toBe("Updated via htmx!")
	})

	it("should return error when file does not exist", async () => {
		const formData = new FormData()
		formData.append("path", "public/non-existent.txt")
		formData.append("content", "New content")

		const res = await app.request(
			new Request("http://localhost/api/update", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as { success: boolean; error: { name: string } }
		expect(data.success).toBe(false)
		expect(data.error.name).toBe("FileNotFound")
	})

	it("should reject update to path traversal path", async () => {
		const formData = new FormData()
		formData.append("path", "../../evil.txt")
		formData.append("content", "Hacked!")

		const res = await app.request(
			new Request("http://localhost/api/update", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as { success: boolean; error: { name: string } }
		expect(data.success).toBe(false)
		expect(data.error.name).toBe("PathError")
	})

	it("should return error when path is a directory", async () => {
		await mkdir(path.join(UPLOAD_DIR, "public", "testdir"), { recursive: true })

		const formData = new FormData()
		formData.append("path", "public/testdir")
		formData.append("content", "New content")

		const res = await app.request(
			new Request("http://localhost/api/update", { method: "POST", body: formData }),
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as { success: boolean; error: { name: string } }
		expect(data.success).toBe(false)
		expect(data.error.name).toBe("NotAFile")
	})

	it("should update a file in nested directory", async () => {
		const nestedDir = path.join(UPLOAD_DIR, "public", "update/foo")
		await mkdir(nestedDir, { recursive: true })
		const testFilePath = path.join(nestedDir, "bar.txt")
		await writeFile(testFilePath, "Nested initial content", "utf-8")

		const formData = new FormData()
		formData.append("path", "public/update/foo/bar.txt")
		formData.append("content", "Updated nested content!")

		const res = await app.request(
			new Request("http://localhost/api/update", {
				method: "POST",
				body: formData,
				headers: { "HX-Request": "true" },
			}),
		)
		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).toContain("bar.txt")
		expect(text).toContain("Updated nested content!")

		const saved = await readFile(testFilePath, "utf-8")
		expect(saved).toBe("Updated nested content!")
	})
})
