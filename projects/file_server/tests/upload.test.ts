import { beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import app from "../src/index";

describe("upload", () => {
  const UPLOAD_DIR = "./tmp-test";

  beforeEach(async () => {
    // テスト用のアップロードディレクトリを作成
    await mkdir(UPLOAD_DIR, { recursive: true });
    // 環境変数を設定
    process.env.UPLOAD_DIR = UPLOAD_DIR;
  });

  it("should upload a file", async () => {
    // テストファイルを作成
    const testContent = "Hello, World!";
    const testFile = new File([testContent], "test.txt", {
      type: "text/plain",
    });

    // FormDataを作成
    const formData = new FormData();
    formData.append("file", testFile);

    // アップロードリクエストを送信
    const req = new Request("http://localhost/upload", {
      method: "POST",
      body: formData,
    });

    const res = await app.request(req);

    // レスポンスを検証
    expect(res.status).toBe(200);
    const responseData = await res.json();
    expect(responseData).toEqual({});

    // ファイルが実際に保存されたかを確認
    const savedFilePath = path.join(UPLOAD_DIR, "test.txt");
    const savedContent = await readFile(savedFilePath, "utf-8");
    expect(savedContent).toBe(testContent);

    // ファイル一覧を取得して検証
    const listReq = new Request("http://localhost/");
    const listRes = await app.request(listReq);

    const listData = await listRes.json();
    expect(listData.files).toContain("test.txt");
  });

  it("should return error when no file is uploaded", async () => {
    // ファイルなしでFormDataを作成
    const formData = new FormData();

    // アップロードリクエストを送信
    const req = new Request("http://localhost/upload", {
      method: "POST",
      body: formData,
    });

    const res = await app.request(req);

    // レスポンスを検証（Zodバリデーションエラー）
    expect(res.status).toBe(400);
    const responseData = await res.json();
    expect(responseData.success).toBe(false);
    expect(responseData.error).toBeDefined();
    expect(responseData.error.name).toBe("ZodError");
    expect(responseData.error.message).toContain("Input not instance of File");
  });
});
