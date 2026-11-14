// 状態変更 API の入口チェックのユニットテスト

import { describe, expect, test } from "bun:test";
import { isJsonRequest, isSameOriginRequest } from "./request";

function request(headers: Record<string, string>): Request {
  return { headers: new Headers(headers) } as Request;
}

describe("isSameOriginRequest", () => {
  test("Origin がなければ許可する", () => {
    expect(isSameOriginRequest(request({ host: "portal.home.arpa" }))).toBe(true);
  });

  test("Host と Origin のホストが一致すれば許可する", () => {
    expect(
      isSameOriginRequest(
        request({
          host: "portal.home.arpa",
          origin: "https://portal.home.arpa",
        }),
      ),
    ).toBe(true);
  });

  test("ポートを含めて一致すれば許可する", () => {
    expect(
      isSameOriginRequest(
        request({
          host: "192.0.2.10:3000",
          origin: "http://192.0.2.10:3000",
        }),
      ),
    ).toBe(true);
  });

  test("別ホストからの Origin は拒否する", () => {
    expect(
      isSameOriginRequest(
        request({
          host: "portal.home.arpa",
          origin: "https://example.com",
        }),
      ),
    ).toBe(false);
  });

  test("Origin があるのに Host が無ければ拒否する", () => {
    expect(isSameOriginRequest(request({ origin: "https://portal.home.arpa" }))).toBe(false);
  });

  test("不正な Origin は拒否する", () => {
    expect(isSameOriginRequest(request({ host: "portal.home.arpa", origin: "not a url" }))).toBe(
      false,
    );
  });
});

describe("isJsonRequest", () => {
  test("charset 付きの application/json を許可する", () => {
    expect(isJsonRequest(request({ "content-type": "application/json; charset=utf-8" }))).toBe(
      true,
    );
  });

  test("大文字と前後の空白を無視する", () => {
    expect(isJsonRequest(request({ "content-type": " Application/JSON " }))).toBe(true);
  });

  test("それ以外の Content-Type は拒否する", () => {
    expect(isJsonRequest(request({ "content-type": "text/plain" }))).toBe(false);
    expect(isJsonRequest(request({}))).toBe(false);
  });
});
