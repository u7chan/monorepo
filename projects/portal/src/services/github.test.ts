// GitHub Packages の version 変換と、manual-deploy 起動リクエストのユニットテスト

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { dispatchDeploy, listImageTags, toImageTagOptions } from "./github";

const originalFetch = globalThis.fetch;
const originalDeployToken = process.env.PORTAL_GITHUB_TOKEN;
const originalGhcrToken = process.env.PORTAL_GHCR_TOKEN;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  process.env.PORTAL_GITHUB_TOKEN = "deploy-token";
  process.env.PORTAL_GHCR_TOKEN = "ghcr-token";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDeployToken === undefined) {
    delete process.env.PORTAL_GITHUB_TOKEN;
  } else {
    process.env.PORTAL_GITHUB_TOKEN = originalDeployToken;
  }
  if (originalGhcrToken === undefined) {
    delete process.env.PORTAL_GHCR_TOKEN;
  } else {
    process.env.PORTAL_GHCR_TOKEN = originalGhcrToken;
  }
});

describe("toImageTagOptions", () => {
  test("新しい version のタグを先に並べ、latest は含めない", () => {
    const versions = [
      {
        created_at: "2026-11-12T00:00:00Z",
        metadata: { container: { tags: ["sha-old"] } },
      },
      {
        created_at: "2026-11-13T00:00:00Z",
        metadata: { container: { tags: ["latest", "sha-new"] } },
      },
    ];

    expect(toImageTagOptions(versions)).toEqual([
      { tag: "sha-new", createdAt: "2026-11-13T00:00:00Z" },
      { tag: "sha-old", createdAt: "2026-11-12T00:00:00Z" },
    ]);
  });

  test("同じタグは新しい version の日付で 1 回だけ返す", () => {
    const versions = [
      {
        created_at: "2026-11-13T00:00:00Z",
        metadata: { container: { tags: ["sha-dup"] } },
      },
      {
        created_at: "2026-11-12T00:00:00Z",
        metadata: { container: { tags: ["sha-dup"] } },
      },
    ];

    expect(toImageTagOptions(versions)).toEqual([
      { tag: "sha-dup", createdAt: "2026-11-13T00:00:00Z" },
    ]);
  });

  test("タグのない version は無視する", () => {
    const versions = [
      { created_at: "2026-11-13T00:00:00Z" },
      {
        created_at: "2026-11-12T00:00:00Z",
        metadata: { container: { tags: [] } },
      },
    ];

    expect(toImageTagOptions(versions)).toEqual([]);
  });

  test("Docker のタグとして不正な文字列と latest は無視する", () => {
    const versions = [
      {
        created_at: "2026-11-13T00:00:00Z",
        metadata: { container: { tags: ["", "team/tag", "latest", "sha-ok"] } },
      },
    ];

    expect(toImageTagOptions(versions)).toEqual([
      { tag: "sha-ok", createdAt: "2026-11-13T00:00:00Z" },
    ]);
  });

  test("latest だけの version は選択肢を返さない", () => {
    const versions = [
      {
        created_at: "2026-11-13T00:00:00Z",
        metadata: { container: { tags: ["latest"] } },
      },
    ];

    expect(toImageTagOptions(versions)).toEqual([]);
  });
});

describe("listImageTags", () => {
  test("GHCR 用の token で GitHub Packages API からタグを取得する", async () => {
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://api.github.com/users/u7chan/packages/container/monorepo%2Fportal/versions?per_page=100",
      );
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ghcr-token");
      return response([
        {
          created_at: "2026-11-13T13:06:22Z",
          metadata: { container: { tags: ["sha-0ff5c144", "latest"] } },
        },
      ]);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(listImageTags("portal")).resolves.toEqual([
      { tag: "sha-0ff5c144", createdAt: "2026-11-13T13:06:22Z" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("GHCR 用の token がなければ 503 を返す", async () => {
    delete process.env.PORTAL_GHCR_TOKEN;
    const fetchMock = mock(async () => response([]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(listImageTags("portal")).rejects.toMatchObject({
      status: 503,
      message: "Image tags are not configured. Set PORTAL_GHCR_TOKEN on the host.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("GitHub の 401 は portal 側の設定エラーとして 503 にする", async () => {
    globalThis.fetch = mock(async () =>
      response({ message: "Bad credentials" }, 401),
    ) as unknown as typeof fetch;

    await expect(listImageTags("portal")).rejects.toMatchObject({
      status: 503,
      message: "Bad credentials",
    });
  });

  test("不正な project 名はリクエスト前に拒否する", async () => {
    const fetchMock = mock(async () => response([]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(listImageTags("../portal")).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("dispatchDeploy", () => {
  test("deploy 用の token で manual-deploy を target と tag 付きで起動する", async () => {
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://api.github.com/repos/u7chan/self-hosted-runner/actions/workflows/manual-deploy.yml/dispatches",
      );
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer deploy-token");
      expect(JSON.parse(String(init?.body))).toEqual({
        ref: "main",
        inputs: {
          target: "usage-portal",
          image_tag: "sha-abc1234",
          action: "deploy",
        },
      });
      return new Response(null, { status: 204 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(dispatchDeploy("usage-portal", "sha-abc1234")).resolves.toBe(
      "https://github.com/u7chan/self-hosted-runner/actions/workflows/manual-deploy.yml",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("deploy 用の token がなければ 503 を返す", async () => {
    delete process.env.PORTAL_GITHUB_TOKEN;
    const fetchMock = mock(async () => new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(dispatchDeploy("usage-portal", "sha-abc1234")).rejects.toMatchObject({
      status: 503,
      message: "Deploy is not configured. Set PORTAL_GITHUB_TOKEN on the host.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("不正な target と tag はリクエスト前に拒否する", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(dispatchDeploy("../portal", "sha-abc1234")).rejects.toMatchObject({
      status: 400,
    });
    await expect(dispatchDeploy("usage-portal", "team/tag")).rejects.toMatchObject({
      status: 400,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("GitHub の 404 は 502 にする", async () => {
    globalThis.fetch = mock(async () =>
      response({ message: "Not Found" }, 404),
    ) as unknown as typeof fetch;

    await expect(dispatchDeploy("usage-portal", "sha-abc1234")).rejects.toMatchObject({
      status: 502,
      message: "Not Found",
    });
  });
});
