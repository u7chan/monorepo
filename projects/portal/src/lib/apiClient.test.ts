// API クライアントのユニットテスト

import { describe, expect, test } from "bun:test";
import {
  ApiError,
  readApiError,
  readApiMessage,
  readJsonBody,
  readStatusError,
  requestJson,
  type FetchLike,
} from "./apiClient";

function fetchStub(response: Response): FetchLike {
  return async () => response;
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("readApiError", () => {
  test("message を error より優先する", () => {
    expect(readApiError({ message: "message text", error: "error text" }, "fallback")).toBe(
      "message text",
    );
  });

  test("message が無ければ error を使う", () => {
    expect(readApiError({ error: "error text" }, "fallback")).toBe("error text");
  });

  test("どちらも無ければ fallback を返す", () => {
    expect(readApiError({}, "fallback")).toBe("fallback");
    expect(readApiError(null, "fallback")).toBe("fallback");
    expect(readApiError("error text", "fallback")).toBe("fallback");
  });

  test("空文字と非文字列のフィールドは無視する", () => {
    expect(readApiError({ message: "", error: "error text" }, "fallback")).toBe("error text");
    expect(readApiError({ message: 1, error: false }, "fallback")).toBe("fallback");
    expect(readApiError({ message: " ", error: "" }, "fallback")).toBe(" ");
  });
});

describe("readApiMessage", () => {
  test("message だけを見て error は使わない", () => {
    expect(readApiMessage({ message: "action failed", error: "error text" }, "fallback")).toBe(
      "action failed",
    );
    expect(readApiMessage({ error: "error text" }, "fallback")).toBe("fallback");
    expect(readApiMessage(null, "fallback")).toBe("fallback");
  });
});

describe("readStatusError", () => {
  test("body を無視して fallback を返す", () => {
    expect(readStatusError({ message: "message text" }, "HTTP error! status: 500")).toBe(
      "HTTP error! status: 500",
    );
  });
});

describe("readJsonBody", () => {
  test("JSON をそのまま返す", async () => {
    expect(await readJsonBody(Response.json({ host: "portal.example" }))).toEqual({
      host: "portal.example",
    });
  });

  test("JSON でないボディは null を返す", async () => {
    const response = new Response("<html>error</html>", {
      status: 500,
      headers: { "content-type": "text/html" },
    });

    expect(await readJsonBody(response)).toBeNull();
  });

  test("空のボディは null を返す", async () => {
    expect(await readJsonBody(new Response(""))).toBeNull();
  });
});

describe("requestJson", () => {
  test("成功時はボディを返す", async () => {
    const body = await requestJson("/api/config", undefined, () => "fallback", {
      fetchImpl: fetchStub(Response.json({ host: "portal.example" })),
    });

    expect(body).toEqual({ host: "portal.example" });
  });

  test("入力と init を fetch へ渡す", async () => {
    const calls: { input?: RequestInfo | URL; init?: RequestInit } = {};
    const fetchImpl: FetchLike = async (input, init) => {
      calls.input = input;
      calls.init = init;
      return Response.json({});
    };

    await requestJson("/api/deployments", { method: "POST" }, () => "fallback", { fetchImpl });

    expect(calls.input).toBe("/api/deployments");
    expect(calls.init).toEqual({ method: "POST" });
  });

  test("失敗時は message と status と body を持つ ApiError を投げる", async () => {
    const error = await captureError(
      requestJson("/api/deployments", { method: "POST" }, () => "fallback", {
        fetchImpl: fetchStub(
          Response.json({ message: "Image switching is not available" }, { status: 409 }),
        ),
      }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      name: "ApiError",
      message: "Image switching is not available",
      status: 409,
      body: { message: "Image switching is not available" },
    });
  });

  test("message が無ければ error を使う", async () => {
    const error = await captureError(
      requestJson("/api/deployments", undefined, () => "fallback", {
        fetchImpl: fetchStub(Response.json({ error: "server error" }, { status: 503 })),
      }),
    );

    expect(error).toMatchObject({ message: "server error", status: 503 });
  });

  test("fallback は status を受け取る", async () => {
    const error = await captureError(
      requestJson("/api/containers", undefined, (status) => `HTTP error! status: ${status}`, {
        fetchImpl: fetchStub(Response.json({}, { status: 503 })),
      }),
    );

    expect(error).toMatchObject({ message: "HTTP error! status: 503", status: 503 });
  });

  test("JSON でないエラーボディは fallback を使う", async () => {
    const error = await captureError(
      requestJson("/api/containers", undefined, (status) => `HTTP error! status: ${status}`, {
        fetchImpl: fetchStub(new Response("<html>error</html>", { status: 500 })),
      }),
    );

    expect(error).toMatchObject({ message: "HTTP error! status: 500", status: 500, body: null });
  });

  test("readError を差し替えると body を使わないメッセージにできる", async () => {
    const error = await captureError(
      requestJson("/api/config", undefined, (status) => `HTTP error! status: ${status}`, {
        readError: readStatusError,
        fetchImpl: fetchStub(Response.json({ message: "server message" }, { status: 500 })),
      }),
    );

    expect(error).toMatchObject({ message: "HTTP error! status: 500", status: 500 });
  });

  test("readError を差し替えると message だけを見るメッセージにできる", async () => {
    const error = await captureError(
      requestJson("/api/containers/abc/start", { method: "POST" }, (status) => `status ${status}`, {
        readError: readApiMessage,
        fetchImpl: fetchStub(Response.json({ error: "server error" }, { status: 409 })),
      }),
    );

    expect(error).toMatchObject({ message: "status 409", status: 409 });
  });
});
