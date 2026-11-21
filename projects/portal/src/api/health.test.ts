// ヘルスチェック API のユニットテスト

import { describe, expect, test } from "bun:test";
import { getHello, getHelloByName, putHello } from "./health";

describe("getHello", () => {
  test("GET のヘルスチェックに応答する", async () => {
    const response = getHello(new Request("http://portal.example/api/hello"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "Hello, world!", method: "GET" });
  });
});

describe("putHello", () => {
  test("PUT のヘルスチェックに応答する", async () => {
    const response = putHello(new Request("http://portal.example/api/hello", { method: "PUT" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "Hello, world!", method: "PUT" });
  });
});

describe("getHelloByName", () => {
  test("パスパラメータの name を返す", async () => {
    const response = getHelloByName(new Request("http://portal.example/api/hello/portal"), {
      name: "portal",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "Hello, portal!" });
  });

  test("空の name でもそのまま返す", async () => {
    const response = getHelloByName(new Request("http://portal.example/api/hello/"), { name: "" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "Hello, !" });
  });
});
