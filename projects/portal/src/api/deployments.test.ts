// デプロイ API の対象判定・リクエスト解釈・レスポンス契約のユニットテスト

import { describe, expect, test } from "bun:test";
import { DEPLOY_WORKFLOW_URL } from "../services/github";
import { mockImageTags } from "../services/mockData";
import type { Container } from "../types/container";
import {
  findDeployTarget,
  getDeployOptions,
  parseDeploymentRequest,
  postDeployment,
  type ContainerLoader,
} from "./deployments";

function container(overrides: Partial<Container> = {}): Container {
  return {
    id: "abc123",
    name: "app",
    image: "ghcr.io/u7chan/monorepo/app:sha-1234567",
    state: "running",
    status: "Up 1 hour",
    ports: [],
    ...overrides,
  };
}

function loaderFor(...items: Container[]): ContainerLoader {
  return async () => items;
}

async function withMockMode<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.USE_MOCK_DATA;
  process.env.USE_MOCK_DATA = "true";
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.USE_MOCK_DATA;
    } else {
      process.env.USE_MOCK_DATA = previous;
    }
  }
}

function deployOptionsRequest(id: string, loadContainers: ContainerLoader): Promise<Response> {
  return getDeployOptions(
    new Request(`http://portal.example/api/containers/${id}/deploy-options`),
    { id },
    loadContainers,
  );
}

function deploymentRequest(
  containerId: string,
  loadContainers: ContainerLoader,
  tag = "sha-7654321",
): Promise<Response> {
  return postDeployment(
    new Request("http://portal.example/api/deployments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ containerId, tag }),
    }),
    loadContainers,
  );
}

describe("findDeployTarget", () => {
  test("id が一致するコンテナが無ければ not-found", () => {
    expect(findDeployTarget([container()], "missing")).toEqual({ kind: "not-found" });
  });

  test("canDeploy が false なら container-not-deployable", () => {
    expect(
      findDeployTarget([container({ canDeploy: false, deployTarget: "app" })], "abc123"),
    ).toEqual({ kind: "container-not-deployable" });
  });

  test("deployTarget が無ければ container-not-deployable", () => {
    expect(findDeployTarget([container({ canDeploy: true })], "abc123")).toEqual({
      kind: "container-not-deployable",
    });
  });

  test("monorepo のイメージでなければ project-not-deployable", () => {
    expect(
      findDeployTarget(
        [container({ canDeploy: true, deployTarget: "app", image: "nginx:alpine" })],
        "abc123",
      ),
    ).toEqual({ kind: "project-not-deployable" });
  });

  test("デプロイ可能なら deploy target と project を返す", () => {
    const target = container({ canDeploy: true, deployTarget: "app" });

    expect(findDeployTarget([target], "abc123")).toEqual({
      kind: "ready",
      container: target,
      deployTarget: "app",
      project: "app",
    });
  });

  test("id が複数あるときは一致するコンテナだけを見る", () => {
    const other = container({ id: "other" });
    const target = container({ canDeploy: true, deployTarget: "app" });

    expect(findDeployTarget([other, target], "abc123")).toMatchObject({
      kind: "ready",
      deployTarget: "app",
    });
  });
});

describe("getDeployOptions", () => {
  test("未知のコンテナは 404 Container not found", async () => {
    const response = await deployOptionsRequest("missing", loaderFor(container()));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Container not found" });
  });

  test("デプロイ非対応のコンテナは 409 でコンテナ向けの文言を返す", async () => {
    const response = await deployOptionsRequest(
      "abc123",
      loaderFor(container({ canDeploy: false, deployTarget: "app" })),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Image switching is not available for this container",
    });
  });

  test("monorepo 外のイメージは 409 でイメージ向けの文言を返す", async () => {
    const response = await deployOptionsRequest(
      "abc123",
      loaderFor(container({ canDeploy: true, deployTarget: "app", image: "nginx:alpine" })),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Image switching is not available for this image",
    });
  });

  test("デプロイ可能なら 200 でタグ一覧を返す", async () => {
    const loadContainers = loaderFor(container({ canDeploy: true, deployTarget: "app" }));

    await withMockMode(async () => {
      const response = await deployOptionsRequest("abc123", loadContainers);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        target: "app",
        currentTag: "sha-1234567",
        tags: mockImageTags,
      });
    });
  });
});

describe("parseDeploymentRequest", () => {
  test("オブジェクト以外は Invalid request body", () => {
    expect(parseDeploymentRequest(null)).toEqual({ ok: false, error: "Invalid request body" });
    expect(parseDeploymentRequest("containerId=abc")).toEqual({
      ok: false,
      error: "Invalid request body",
    });
  });

  test("containerId と tag が string でなければ required", () => {
    expect(parseDeploymentRequest({})).toEqual({
      ok: false,
      error: "containerId and tag are required",
    });
    expect(parseDeploymentRequest({ containerId: 1, tag: "sha-1234567" })).toEqual({
      ok: false,
      error: "containerId and tag are required",
    });
    expect(parseDeploymentRequest({ containerId: "abc123", tag: null })).toEqual({
      ok: false,
      error: "containerId and tag are required",
    });
  });

  test("latest や不正な形式のタグは Invalid image tag", () => {
    expect(parseDeploymentRequest({ containerId: "abc123", tag: "latest" })).toEqual({
      ok: false,
      error: "Invalid image tag",
    });
    expect(parseDeploymentRequest({ containerId: "abc123", tag: "sha-1234567\n" })).toEqual({
      ok: false,
      error: "Invalid image tag",
    });
  });

  test("正しい body は containerId と tag を取り出す", () => {
    expect(parseDeploymentRequest({ containerId: "abc123", tag: "sha-1234567" })).toEqual({
      ok: true,
      request: { containerId: "abc123", tag: "sha-1234567" },
    });
  });
});

describe("postDeployment", () => {
  test("別オリジンからのリクエストは 403 を返す", async () => {
    const request = {
      url: "http://portal.example/api/deployments",
      headers: new Headers({ host: "portal.example", origin: "https://evil.example" }),
    } as Request;

    const response = await postDeployment(request);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Cross-origin request is not allowed" });
  });

  test("JSON 以外の Content-Type は 415 を返す", async () => {
    const request = new Request("http://portal.example/api/deployments", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "containerId=abc123&tag=sha-1234567",
    });

    const response = await postDeployment(request);

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({
      error: "Content-Type must be application/json",
    });
  });

  test("壊れた JSON は 400 を返す", async () => {
    const request = new Request("http://portal.example/api/deployments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    const response = await postDeployment(request);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON body" });
  });

  test("必須項目が無い JSON は 400 を返す", async () => {
    const request = new Request("http://portal.example/api/deployments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag: "sha-1234567" }),
    });

    const response = await postDeployment(request);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "containerId and tag are required" });
  });

  test("デプロイできないタグは 400 を返す", async () => {
    const request = new Request("http://portal.example/api/deployments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ containerId: "abc123", tag: "latest" }),
    });

    const response = await postDeployment(request);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid image tag" });
  });

  test("未知のコンテナは 404 Container not found", async () => {
    const response = await deploymentRequest("missing", loaderFor(container()));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Container not found" });
  });

  test("デプロイ非対応のコンテナは 409 を返す", async () => {
    const response = await deploymentRequest(
      "abc123",
      loaderFor(container({ canDeploy: false, deployTarget: "app" })),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Image switching is not available for this container",
    });
  });

  test("monorepo 外のイメージは 409 でコンテナ向けの文言を返す", async () => {
    const response = await deploymentRequest(
      "abc123",
      loaderFor(container({ canDeploy: true, deployTarget: "app", image: "nginx:alpine" })),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Image switching is not available for this container",
    });
  });

  test("デプロイ可能なら 202 で workflow URL を返す", async () => {
    const loadContainers = loaderFor(container({ canDeploy: true, deployTarget: "app" }));

    await withMockMode(async () => {
      const response = await deploymentRequest("abc123", loadContainers);

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        target: "app",
        tag: "sha-7654321",
        workflowUrl: DEPLOY_WORKFLOW_URL,
      });
    });
  });
});
