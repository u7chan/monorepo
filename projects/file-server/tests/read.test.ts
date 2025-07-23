import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import * as path from "node:path"
import app from "../src/index"

describe("read", () => {
  const UPLOAD_DIR = "./tmp-test"

  beforeEach(async () => {
    // 既存のディレクトリを削除してから作成
    try {
      await rm(UPLOAD_DIR, { recursive: true, force: true })
    } catch (_error) {
      // ディレクトリが存在しない場合は無視
    }
    // テスト用のアップロードディレクトリを作成
    await mkdir(UPLOAD_DIR, { recursive: true })
    // 環境変数を設定
    process.env.UPLOAD_DIR = UPLOAD_DIR
  })

  afterEach(async () => {
    // テスト用ディレクトリをクリーンアップ
    try {
      await rm(UPLOAD_DIR, { recursive: true, force: true })
    } catch (_error) {
      // ディレクトリが存在しない場合は無視
    }
  })

  it("should return empty files list when directory is empty", async () => {
    // ファイル一覧取得リクエスト
    const req = new Request("http://localhost/api/")
    const res = await app.request(req)

    // レスポンスを検証
    expect(res.status).toBe(200)
    const responseData = await res.json()
    expect(responseData.files).toEqual([])
  })

  it("should return files list when files exist", async () => {
    // テストファイルを作成
    await Bun.write(path.join(UPLOAD_DIR, "test1.txt"), "Hello, World!")
    await Bun.write(path.join(UPLOAD_DIR, "test2.txt"), "Test content")

    // ファイル一覧取得リクエスト
    const req = new Request("http://localhost/api/")
    const res = await app.request(req)

    // レスポンスを検証
    expect(res.status).toBe(200)
    const responseData = await res.json()
    expect(responseData.files).toEqual(
      expect.arrayContaining([
        { name: "test1.txt", type: "file" },
        { name: "test2.txt", type: "file" },
      ]),
    )
    expect(responseData.files).toHaveLength(2)
  })

  it("should return files list in subdirectory when subpath is specified", async () => {
    // サブディレクトリとファイルを作成
    await mkdir(path.join(UPLOAD_DIR, "foo/bar"), { recursive: true })
    await Bun.write(path.join(UPLOAD_DIR, "foo/bar", "baz.txt"), "baz content")
    await Bun.write(path.join(UPLOAD_DIR, "foo/bar", "qux.txt"), "qux content")
    // サブディレクトリ直下のファイルも作成
    await Bun.write(path.join(UPLOAD_DIR, "foo", "root.txt"), "root content")

    // サブパス指定でリクエスト
    const req = new Request("http://localhost/api/foo/bar")
    const res = await app.request(req)

    // レスポンスを検証
    expect(res.status).toBe(200)
    const responseData = await res.json()
    expect(responseData.files).toEqual(
      expect.arrayContaining([
        { name: "baz.txt", type: "file" },
        { name: "qux.txt", type: "file" },
      ]),
    )
    expect(responseData.files).toHaveLength(2)
  })

  it("should handle non-existent directory gracefully", async () => {
    // 存在しないディレクトリを設定
    process.env.UPLOAD_DIR = "./non-existent-dir"

    // ファイル一覧取得リクエスト
    const req = new Request("http://localhost/api/")
    const res = await app.request(req)

    // レスポンスを検証（エラーが発生するはず）
    expect(res.status).toBe(400)
    const responseData = await res.json()
    expect(responseData.success).toBe(false)
    expect(responseData.error).toBeDefined()
    expect(responseData.error.name).toBe("DirNotFound")

    // 環境変数を元に戻す
    process.env.UPLOAD_DIR = UPLOAD_DIR
  })
})
