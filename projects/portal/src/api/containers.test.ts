// コンテナ API のクエリ・パスパラメータ解釈のユニットテスト

import { describe, expect, test } from "bun:test";
import { parseContainerAction, parseContainerListQuery, postContainerAction } from "./containers";

function fakeRequest(url: string, headers: Record<string, string>): Request {
  return { url, headers: new Headers(headers) } as Request;
}

describe("parseContainerListQuery", () => {
  test("filter が無いときは全状態を取得する", () => {
    expect(parseContainerListQuery(null)).toEqual({ filter: "all", includeAllStates: true });
  });

  test("空文字は all として扱う", () => {
    expect(parseContainerListQuery("")).toEqual({ filter: "all", includeAllStates: true });
  });

  test("all は全状態を取得する", () => {
    expect(parseContainerListQuery("all")).toEqual({ filter: "all", includeAllStates: true });
  });

  test("stopped は全状態を取得する", () => {
    expect(parseContainerListQuery("stopped")).toEqual({
      filter: "stopped",
      includeAllStates: true,
    });
  });

  test("running は稼働中だけを取得する", () => {
    expect(parseContainerListQuery("running")).toEqual({
      filter: "running",
      includeAllStates: false,
    });
  });

  test("未知の値は絞り込まず、全状態も取得しない", () => {
    expect(parseContainerListQuery("paused")).toEqual({
      filter: "paused" as never,
      includeAllStates: false,
    });
  });
});

describe("parseContainerAction", () => {
  test("start と stop を受け付ける", () => {
    expect(parseContainerAction("start")).toBe("start");
    expect(parseContainerAction("stop")).toBe("stop");
  });

  test("start / stop 以外は受け付けない", () => {
    expect(parseContainerAction("restart")).toBeUndefined();
    expect(parseContainerAction("START")).toBeUndefined();
    expect(parseContainerAction("")).toBeUndefined();
  });
});

describe("postContainerAction", () => {
  test("別オリジンからの操作は 403 を返す", async () => {
    const response = await postContainerAction(
      fakeRequest("http://portal.example/api/containers/abc/start", {
        host: "portal.example",
        origin: "https://evil.example",
      }),
      { id: "abc", action: "start" },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Cross-origin request is not allowed" });
  });

  test("start / stop 以外のアクションは 400 を返す", async () => {
    const response = await postContainerAction(
      fakeRequest("http://portal.example/api/containers/abc/restart", {}),
      { id: "abc", action: "restart" },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid container action",
      message: "Action must be start or stop",
    });
  });
});
