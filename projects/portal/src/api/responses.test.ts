// API 共通レスポンスのユニットテスト

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { GithubServiceError } from "../services/github";
import { crossOriginResponse, deployErrorResponse } from "./responses";

let consoleErrorSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  consoleErrorSpy?.mockRestore();
  consoleErrorSpy = undefined;
});

describe("crossOriginResponse", () => {
  test("403 とエラーメッセージを返す", async () => {
    const response = crossOriginResponse();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Cross-origin request is not allowed" });
  });
});

describe("deployErrorResponse", () => {
  test("GithubServiceError は status と message をそのまま返す", async () => {
    const response = deployErrorResponse(
      new GithubServiceError("Deploy is not configured. Set PORTAL_GITHUB_TOKEN on the host.", 503),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Deploy request failed",
      message: "Deploy is not configured. Set PORTAL_GITHUB_TOKEN on the host.",
    });
  });

  test("それ以外のエラーは 500 と Unexpected error を返す", async () => {
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});

    const response = deployErrorResponse(new Error("socket closed"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Deploy request failed",
      message: "Unexpected error",
    });
  });
});
